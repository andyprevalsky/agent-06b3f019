#!/usr/bin/env python3
# Benchmark harness v2
"""
Agent Benchmark Harness

Spawns real agents against prod (or localhost), polls for completion,
evaluates pass/fail, handles approvals, and stores results for comparison.

Usage:
    python benchmarks/run_benchmark.py --list
    python benchmarks/run_benchmark.py --task chat-mode
    python benchmarks/run_benchmark.py --suite basic
    python benchmarks/run_benchmark.py --suite smoke --parallel --ci   # PR smoke test
    python benchmarks/run_benchmark.py --suite all --url https://navi-j9a9.onrender.com
    python benchmarks/run_benchmark.py --compare runs/A.json runs/B.json

Auto-debug mode:
    Use the `/benchmark <task-name>` skill in Claude Code. It contains the full
    12-step auto-debug loop with monitoring, diagnosis, fix, PR, deploy, and rerun.

    Log inspection CLI (run all three summaries in parallel — they answer different questions):
      python benchmarks/agent_latency.py <agent_id>           # span waterfall + slowest paths/LLMs/HTTP
      python benchmarks/agent_logs.py <agent_id> --tree --diagnostics  # event-timeline tree w/ errors
      python benchmarks/run_benchmark.py --compare <run.json> # tree-wide token + cache breakdown
      # Expand whichever summary found the issue:
      python benchmarks/agent_latency.py <agent_id> -v
      python benchmarks/agent_logs.py <agent_id> --tree --source worker|backend|research|messages
"""

import argparse
import asyncio
import contextvars
import copy
import csv
import fcntl
import hashlib
import inspect
import ipaddress
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Iterator, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

import httpx

# Add parent dir to path so we can import from agents/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from benchmarks import auth_assistance_user, auth_test_site, cloud_batch_cleanup, display_check
from benchmarks.benchmark_tasks import (
    RUNNABLE_TASK_RUNNERS,
    BenchmarkTask,
    all_tasks,
    apply_sub_agent_count,
    get_smoke_cap,
    get_task_by_name,
    get_tasks_by_tag,
    get_timeout_floor,
    list_all_tasks,
)
from benchmarks.context_validator import validate_context
from benchmarks.live_fixtures import (
    AMAN_FOOD_PLAN_COOKIE_DOMAINS,
    AMAN_FOOD_PLAN_USER_ID,
    LIVE_FIXTURE_NAMES,
    TAMY_IDENTITY_COOKIE_DOMAINS,
    TAMY_IDENTITY_USER_ID,
    resolve_live_fixtures,
)
from benchmarks.llm_usage import (
    aggregate_prompt_cache_share,
    aggregate_usage_items,
    live_output_tokens,
)
from benchmarks.local import manifest_database_url
from benchmarks.logs import (
    canonicalize_agent_tree,
    collect_logs,
    collect_tree_messages,
    extract_message_transcript,
    fetch_local_worker_logs,
    load_env_var,
    start_fly_log_collector,
    start_supabase_realtime_collector,
    stop_fly_log_collector,
    stop_supabase_realtime_collector,
    subscribe_supabase_realtime_agent,
    tree_child_transcript_count,
)
from benchmarks.long_horizon import validate_wmh_initial_state
from benchmarks.phone_callee import (
    PhoneCalleeSession,
    callee_check_failures,
    missing_call_findings,
    phone_recording_playback_failures,
    phone_search_text,
    resolve_callee_prompt,
)
from benchmarks.plan_assertions import evaluate_plan_assertions, find_accepted_plan
from benchmarks.polar_catalog import (
    is_polar_bench_task,
    polar_browser_step_budget,
    polar_wall_clock_disabled,
)
from benchmarks.realtime_monitor import SupabaseRealtimeSmokeMonitor
from benchmarks.results import BenchmarkRun, TaskResult, compare_runs
from benchmarks.spawn_contract import should_disable_saved_browser_auth
from benchmarks.subscription_checkout import complete_test_subscription_checkout
from benchmarks.timeout_history import (
    InsufficientHistoryError,
)
from benchmarks.timeout_history import (
    get_timeout as _history_get_timeout,
)
from benchmarks.timeout_history import (
    summary as _history_summary,
)
from benchmarks.tree_feedback_routing import (
    TREE_ROUTING_CHECK_TYPES,
    background_routing_trace,
    background_trigger_ready,
    check_tree_feedback_routing,
    routing_trace,
    tree_snapshot,
    tree_trigger_ready,
    trigger_uses_background_task,
    trigger_uses_tree,
)
from benchmarks.world_model_harness import (
    archive_artifact_paths,
    evaluate_archive_with_world_model,
    read_archive_json,
    update_world_model_for_simulation,
)
from domains.set_plan.config import (
    PLANNER_ACTIVITY_MAX_ATTEMPTS,
    PLANNER_ACTIVITY_TIMEOUT_SECONDS,
)
from helpers.completion_summary_contract import (
    is_ablated_completion_summary,
)
from helpers.world_model_runtime import WMHHttpClient
from tests.e2e.test_helpers import (
    authenticate,
)
from utils.payment_boundary_goal import PAYMENT_BOUNDARY_GOAL_MARKER

# Defaults — benchmarks run against PROD by default (no local services needed)
DEFAULT_BASE_URL = os.environ.get("BENCHMARK_BASE_URL", "https://navi-j9a9.onrender.com")
PROD_BASE_URL = "https://navi-j9a9.onrender.com"
POLL_INTERVAL = 5  # seconds
STALL_THRESHOLD = 120  # seconds without new messages/agents across ENTIRE tree → warning
# Per-agent early-fail threshold: if every non-terminal leaf emits no durable
# messages for this many seconds, fail fast instead of burning the full task
# timeout on a silent worker. This must be longer than one configured planner
# activity retry envelope because planner progress is realtime-only until the
# plan result is persisted; otherwise cold smoke runs can fail while a valid
# planner retry is still inside its workflow budget.
AGENT_STALL_SECONDS = max(240, PLANNER_ACTIVITY_TIMEOUT_SECONDS * PLANNER_ACTIVITY_MAX_ATTEMPTS + 30)
TREE_POLL_INTERVAL = 15  # seconds between tree-level polls (more expensive than root-only)

# Cloud guests may acknowledge teardown only after every interrupted root has
# crossed the canonical DELETE boundary. The driver supplies a runner-writable,
# run-scoped status path and independently verifies the token before publishing
# the root-owned guest acknowledgement.
_INTERRUPT_CLEANUP_STARTED = 0
_INTERRUPT_CLEANUP_COMPLETED = 0


def _interrupt_cleanup_contract() -> tuple[Path, str] | None:
    status_file = os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE", "").strip()
    token = os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_TOKEN", "").strip()
    if not status_file and not token:
        return None
    path = Path(status_file)
    if not status_file or not path.is_absolute() or re.fullmatch(r"[A-Za-z0-9._-]+", token) is None:
        raise RuntimeError("invalid benchmark interrupt-cleanup contract")
    return path, token


def _publish_interrupt_cleanup_status(state: str) -> None:
    contract = _interrupt_cleanup_contract()
    if contract is None:
        return
    if state not in {"pending", "clean", "failed"}:
        raise ValueError(f"invalid interrupt-cleanup state: {state}")
    status_file, token = contract
    status_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = status_file.with_name(f".{status_file.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write("version=1\n")
            handle.write(f"token={token}\n")
            handle.write(f"state={state}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, status_file)
        directory_fd = os.open(status_file.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _begin_interrupt_cleanup() -> bool:
    global _INTERRUPT_CLEANUP_STARTED
    if _interrupt_cleanup_contract() is None:
        return False
    _INTERRUPT_CLEANUP_STARTED += 1
    _publish_interrupt_cleanup_status("pending")
    print(f"    Benchmark interrupt cleanup status: state=pending started={_INTERRUPT_CLEANUP_STARTED}")
    return True


def _complete_interrupt_cleanup() -> None:
    global _INTERRUPT_CLEANUP_COMPLETED
    _INTERRUPT_CLEANUP_COMPLETED += 1


def _finalize_interrupt_cleanup_status() -> None:
    """Publish one fail-closed run verdict after all interrupted tasks drain."""
    if _interrupt_cleanup_contract() is None or _INTERRUPT_CLEANUP_STARTED == 0:
        return
    clean = _INTERRUPT_CLEANUP_COMPLETED == _INTERRUPT_CLEANUP_STARTED
    state = "clean" if clean else "failed"
    _publish_interrupt_cleanup_status(state)
    print(
        "  Benchmark interrupt cleanup status: "
        f"state={state} started={_INTERRUPT_CLEANUP_STARTED} "
        f"completed={_INTERRUPT_CLEANUP_COMPLETED}"
    )


def has_in_progress_phone_call(messages: list | None) -> bool:
    """True when a live ``call_phone_number`` chip is still in progress.

    A connected hold updates one IN_PROGRESS message in place for hours and
    does not increment ``message_count`` or tree LLM cost until the call ends.
    Tree-stall early-fail must treat that chip as activity or it kills a
    healthy hold after the default ~510s silence budget.
    """
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "call_phone_number":
            continue
        if str(metadata.get("toolStatus") or "").upper() == "IN_PROGRESS":
            return True
    return False


async def world_model_operations_in_flight(
    owned: Optional[dict], *, client: Optional[httpx.AsyncClient] = None
) -> Optional[int]:
    """Live native WMH operations in this run's seeded world, or None when unknown.

    A simulated tool is one blocking WMH step: its waiting leaf emits nothing and
    tree LLM cost does not move while the world model predicts it, so tree-stall
    early-fail must count an in-flight prediction as activity.
    """
    if not owned:
        return None
    url = (
        f"{str(owned['base_url']).rstrip('/')}/world_models/{owned['model_name']}"
        f"/sessions/{owned['session_id']}/activity"
    )
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=5) as owned_client:
                response = await owned_client.get(url)
        else:
            response = await client.get(url, timeout=5)
        body = response.json() if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    value = body.get("operations_in_flight") if isinstance(body, dict) else None
    return value if type(value) is int and value >= 0 else None


def tree_stall_exceeded(*, tree_idle: float, cost_idle: float, world_model_idle: float, limit: float) -> bool:
    """Every progress signal (leaf messages, tree LLM cost, WMH predictions) is quiet past the limit."""
    return min(tree_idle, cost_idle, world_model_idle) > limit


# Claude Code sessions update a single in-place progress chip without
# incrementing ``message_count``. The code agent itself no longer has a runtime
# cap (C11, ddb5d7228), so the benchmark owns this silence budget: 30 minutes of
# one progress chip plus a small buffer.
CLAUDE_CODE_PROGRESS_SILENCE_SECONDS = 1800 + 120


def agent_stall_limit_seconds(task: "BenchmarkTask") -> int:
    """Per-task early-fail silence budget for non-terminal leaves.

    The default stall budget (~510s) false-fails healthy code-agent ranking
    benches mid-session, so tasks that expect / require Claude Code get
    ``CLAUDE_CODE_PROGRESS_SILENCE_SECONDS``.
    """
    limit = int(AGENT_STALL_SECONDS)
    expects_cc = "spawn_claude_code_agent" in (getattr(task, "expected_tools", None) or [])
    requires_cc = bool(getattr(task, "requires_claude_code", False))
    if expects_cc or requires_cc:
        limit = max(limit, CLAUDE_CODE_PROGRESS_SILENCE_SECONDS)
    return limit


_WORLD_MODEL_UPDATE_EVENTS: list[dict[str, Any]] = []
_WORLD_MODEL_UPDATE_RESULT: Optional[dict[str, Any]] = None
CALENDLY_TASK_NAME = "calendly-schedule-meeting"
BIOMETRICS_WEBDECOY_TASK_NAME = "browser-biometrics-webdecoy"
AUTH_BUNDLE_BIOMETRICS_GATE_ENV = "BENCHMARK_AUTH_BUNDLE_BIOMETRICS_GATE"
MINTED_AGENT_ACCOUNT_X_TASK_NAME = "minted-agent-accounts-x"
MINTED_AGENT_ACCOUNT_TASK_NAMES = {
    MINTED_AGENT_ACCOUNT_X_TASK_NAME,
}
MINTED_AGENT_ACCOUNT_X_POST_GOAL = "Make a post on X.com that says, Hello World"
GREP_EXPLORE_STRESS_TASK_NAME = "grep-explore-stress"
AMAZON_PASSKEY_TASK_NAME = "browser-agent-amazon-passkey"
AMAZON_MX_TAMY_TASK_NAME = "browser-agent-amazon-mx-buy-under-5-usd"
# Long-horizon fundraise bench: runs as Tamy's account snapshot under the WMH.
RAISE_5M_BREX_TASK_NAME = "raise-5m-rose-labs-brex"
DOORDASH_FOOD_PLAN_TASK_NAME = "browser-doordash-food-plan-grocery-order"
_DOORDASH_FOOD_PLAN_FIXTURE_CACHE: dict[str, dict] = {}
# Tasks the parallel scheduler must finish (serially) before ordinary work:
# - Destructive shared-DB fixtures: a retained failed agent tree must not mutate
#   rows underneath a sibling. Each fixture must also restore its state.
# - browser-biometrics-webdecoy: FCaptcha PoW + pointer trajectory are timing-
#   sensitive. Overlapping it with another LLM-heavy smoke task (concurrency=2)
#   stalls browser turns for tens of seconds, ages/mismatches the PoW challenge,
#   and the agent burns the 420s cap retrying a rejected checkbox instead of
#   completing. Isolated browser profiles protect cookie/DB state but not this
#   CPU/LLM contention class — keep webdecoy exclusive even then.
# - agent-payment-setup-resume: resets the shared-user AgentCard Integration to
#   connect_required, then expects onboarding attention. A concurrent sibling's
#   live-fixture overlay must not race that fixture (even after compute-token
#   sync stopped rewriting agentcard rows).
EXCLUSIVE_SHARED_DB_TASK_NAMES = {
    GREP_EXPLORE_STRESS_TASK_NAME,
    AMAZON_PASSKEY_TASK_NAME,
    AMAZON_MX_TAMY_TASK_NAME,
    RAISE_5M_BREX_TASK_NAME,
    DOORDASH_FOOD_PLAN_TASK_NAME,
    BIOMETRICS_WEBDECOY_TASK_NAME,
    "agent-payment-setup-resume",
    "sms-supervisor-fill-form-searches-then-delegates",
}
# Trajectory-recall tasks answer from prior agent runs in the canonical base
# image. A local batch shares one stack DB, so a task that finished earlier in
# the batch (claude-code-agent's fresh Collatz run) becomes the newest prior
# trajectory and changes the correct answer. These tasks run in the serial
# exclusive phase, and each starts from the base image's trajectory index.
BASE_TRAJECTORY_HISTORY_SOURCE = "feature:agent-trajectories"
USER_DATA_PROD_GREP_TASK_NAME = "user-data-prod-grep"
MESSAGE_PERSON_TASK_NAME = "message-person"
MESSAGE_PERSON_AGENT_SMS_TASK_NAME = "message-person-agent-sms"
USER_DATA_PROD_DOCUMENT_SOURCES = {"chatgpt", "claude", "apple_notes", "obsidian"}
GREP_BASE_SNAPSHOT_ENV = "BENCHMARK_GREP_BASE_SNAPSHOT"
PLAID_TRANSACTION_BENCHMARK_TASK_NAMES = {
    "plaid-transactions-monthly-spend",
    "plaid-transactions-doordash-count",
    "plaid-transactions-dead-subscriptions",
}
# Tasks answered from the frozen Google Calendar and Drive rows of the
# google_workspace_benchmark_v1 fixture.
GOOGLE_WORKSPACE_BENCHMARK_TASK_NAMES = {
    "google-calendar-day-recall",
    "google-drive-lease-recall",
}
# Live X Hello World grades write-lock + post evidence against the synced CookieBundle.
# Do not steer the agent into MintedAccount signup or phone-auth recovery.
MINTED_AGENT_ACCOUNT_X_AUTH_HINT = (
    "Use the already signed-in X session in the browser if one is available. "
    "Do not create a new X account and do not clear or replace existing X cookies. "
    "Post the text exactly: Hello World."
)
AMAZON_AUTH_ASSISTANCE_TASK_NAME = "browser-agent"
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
NEW_USER_PAYMENT_JOURNEY_TASK_NAME = "agent-payment-new-user-journey"
# Same journey on the hosted Rose Shop: a fresh account per lane, no subscription.
ROSE_SHOP_NO_SUBSCRIPTION_TASK_NAME = "browser-auth-signup-purchase-no-subscription"
AGENT_PAYMENT_PRODUCTION_TASK_NAME = "agent-payment-production-abandonment"
# Hosted Rose Shop purchases settle through the same sandbox AgentCard fixture,
# as the same seeded user. Must equal local.ROSE_SHOP_PAYMENT_TASK_NAMES.
ROSE_SHOP_PAYMENT_TASK_NAMES = {
    "browser-auth-guest-purchase",
    "browser-auth-member-discount-purchase",
    "browser-auth-member-discount-signup-fails-purchase",
    "browser-auth-paid-membership-purchase",
    "browser-auth-signup-purchase",
    "browser-auth-session-expires-at-checkout",
}
AGENT_PAYMENT_SANDBOX_TASK_NAMES = {
    AGENT_PAYMENT_TEST_SHOP_TASK_NAME,
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
} | ROSE_SHOP_PAYMENT_TASK_NAMES
AGENT_PAYMENT_BENCHMARK_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
AGENT_PAYMENT_BENCHMARK_USER_ID_ENV = "BENCHMARK_AGENT_PAYMENT_USER_ID"
AGENT_PAYMENT_FORCE_CUSTOMER_PATH_ENV = "BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH"
BENCHMARK_FORCE_SHOW_PASSWORDS_ENV = "BENCHMARK_FORCE_SHOW_PASSWORDS"
BAD_AMAZON_PASSWORD_USERNAME = "andyprevalsky@yahoo.com"
BAD_AMAZON_COOKIE_SOURCE = "benchmark_bad_auth"
BAD_AMAZON_COOKIE_PROFILE = "force-show-passwords"
TEST_ASSETS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "front-end", "public", "test-assets")
REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV, _BACKEND_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME = "gate-subscription-free-credit"
FREE_CREDIT_SUBSCRIPTION_GATE_USER_ID = "00000000-0000-4000-8000-000000000101"
PURCHASE_SUBSCRIPTION_GATE_TASK_NAME = "gate-subscription-card-mint"
SUBSCRIPTION_WEBHOOK_RESUME_TASK_NAME = "gate-subscription-webhook-resume"
PURCHASE_KYC_GATE_TASK_NAME = "gate-kyc-card-mint"
SOURCE_CONNECT_GATE_TASK_NAME = "gate-source-connect-gmail"
# Admin-bypass counterpart to gate-subscription-card-mint: same depleted (no-subscription) fixture,
# but the run user is a synthetic ADMIN (via ADMIN_USER_IDS_EXTRA), so the card must mint with NO
# subscription gate. Proves the admin bypass end-to-end. Local-only.
PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME = "gate-subscription-card-mint-admin-bypass"
PURCHASE_SUBSCRIPTION_GATE_USER_ID = "00000000-0000-4000-8000-000000000102"
PURCHASE_KYC_GATE_USER_ID = "00000000-0000-4000-8000-000000000103"
SOURCE_CONNECT_GATE_USER_ID = "00000000-0000-4000-8000-000000000104"
# Synthetic admin user for admin-bypass benchmarks — must match ADMIN_USER_IDS_EXTRA in the
# benchmark backend env so isAdminUser() treats it as an admin. Never a real admin's account.
ADMIN_SUBSCRIPTION_BYPASS_USER_ID = "00000000-0000-4000-8000-000000000105"
# Sandbox AgentCard lifecycle benches run as the default admin account so the
# credit gate uses unlimited admin credits. BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH
# (honored only when BENCHMARK_MODE or BENCHMARK_ISOLATED_RUN is on) forces
# resolveAndIssuePurchaseCard onto chargeAndIssueCard so stripeHold remains
# reachable. Must equal BENCHMARK_PAYMENT_LIFECYCLE_ADMIN_RUN_USER_ID in
# back-end/src/domains/purchases/config.ts.
AGENT_PAYMENT_LIFECYCLE_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
AGENT_PAYMENT_LIFECYCLE_TASK_NAMES = {
    AGENT_PAYMENT_TEST_SHOP_TASK_NAME,
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
} | ROSE_SHOP_PAYMENT_TASK_NAMES
# Production counterpart of the four sandbox tasks above, and the same hard requirement.
# `agent-payment-production-abandonment` is /deploy Step 13c and asserts stripeHold succeeded plus
# stripePaymentIntentCount 1; running it as the default (admin) benchmark user routes the mint to
# `issueAdminCompanyCard`, which never creates a payment intent, so the gate cannot pass.
# The identity is deliberately SEPARATE from AGENT_PAYMENT_LIFECYCLE_USER_ID: a user holds exactly
# one Subscription row (one stripeCustomerId) and one agentcard Integration row (one cardholderId),
# and production needs LIVE-mode values where the sandbox fixture needs TEST-mode ones. Must equal
# BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID in back-end/src/domains/purchases/config.ts; provisioned
# once by `back-end/scripts/setup-benchmark-payment.ts --live`.
AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID = "00000000-0000-4000-8000-000000000107"
AGENT_PAYMENT_PRODUCTION_LIFECYCLE_TASK_NAMES = {
    AGENT_PAYMENT_PRODUCTION_TASK_NAME,
    "agent-payment-production-purchase",
}
# Per-task floors on the prompt-cache share: cache_read / (cache_read +
# cache_creation + uncached input) over every cache-sequenced call, the hit rate
# the golden references compute (llm_usage.aggregate_prompt_cache_share). The
# floors were set on the earlier repeatable-group metric (local smoke run
# 4657d9e8: spawn 40.7% -> 25, parallel 47.6% -> 30, browser 51.0% -> 40;
# Claude Code 37.9% -> 35) and are kept: the share adds uncached input and
# one-shot sequenced calls to the denominator, so it is never above the old
# value for the same run, and the same floor is at least as strict.
PER_TASK_CACHE_HIT_RATCHET = {
    "chat-mode": 0.0,
    "spawn-sub-agents": 25.0,
    "parallel-tool-calls": 30.0,
    "claude-code-agent": 35.0,
    "browser-smoke": 40.0,
}
# Per-lane floors (OpenClaw gates each cache lane against its own measured
# baseline: src/agents/live-cache-regression-policy.ts:166, baseline
# src/agents/live-cache-regression-baseline.ts:46-53). The floors above are the
# claude_auth lane. Every other lane uses ONE rule: median of the lane's
# pure-route passing samples x 0.9 (the stable lane's 0.90 / 0.996), capped at
# the task floor; fewer than 3 samples falls back to the task floor. Mixed-route
# runs take the strictest lane floor; unclassified route telemetry fails closed.
#
# Samples: prompt-cache share of passing runs whose sequenced calls all used that
# route, recomputed from saved run records (llm.cache worker events) of proofs
# original600-1792707721330944531, -1792710242163761176, -1792711291636839185,
# -1792722242636117810, -1792738962466034914, -1792795636260090257 and the
# launch-d4fa4238cd31 reruns (2026-10-25).
CACHE_FLOOR_ROUTE_SAMPLES: dict[tuple[str, str], list[float]] = {
    # 4dfb9c60, 2a77030f, d373168f (44.3 4bc084fb was mixed-route, excluded)
    ("spawn-sub-agents", "gpt_auth"): [16.0, 20.3, 26.2],
    # 558c2bec, d4e3bbe1, 720c6179
    ("browser-smoke", "gpt_auth"): [72.6, 75.3, 75.9],
    # 8ba99d40, d5def233
    ("claude-code-agent", "gpt_auth"): [37.3, 46.3],
}
MIN_ROUTE_FLOOR_SAMPLES = 3
ROUTE_FLOOR_BASELINE_RATIO = 0.9


def derive_route_cache_floor(samples: list[float], cap: float) -> float:
    """The uniform lane rule: median x 0.9, capped at the task floor; too few samples keeps the cap."""
    if len(samples) < MIN_ROUTE_FLOOR_SAMPLES:
        return cap
    ordered = sorted(samples)
    middle = len(ordered) // 2
    median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    return min(cap, round(median * ROUTE_FLOOR_BASELINE_RATIO, 1))


def route_cache_floor(task_name: str, routes: list[str]) -> Optional[float]:
    """Floor for a run's served cache lanes; None when route telemetry is missing."""
    task_floor = PER_TASK_CACHE_HIT_RATCHET.get(task_name)
    if task_floor is None:
        return None
    if not routes or "unclassified" in routes:
        return None
    return max(
        derive_route_cache_floor(CACHE_FLOOR_ROUTE_SAMPLES.get((task_name, route), []), cap=task_floor)
        if route != "claude_auth"
        else task_floor
        for route in routes
    )


# deploy.md L1831: Claude Code task correctness stays hard-gated, but its repeatable prompt-cache
# telemetry floor is warn-only wherever the benchmark runs (local or cloud) and every miss is a risk.
CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_TASKS = {"claude-code-agent"}
GATE_FIXTURE_TASK_MODES = {
    PURCHASE_SUBSCRIPTION_GATE_TASK_NAME: "purchase-subscription",
    SUBSCRIPTION_WEBHOOK_RESUME_TASK_NAME: "purchase-subscription",
    # Admin bypass reuses the same depleted fixture; only the run user (an admin) differs.
    PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME: "purchase-subscription",
    PURCHASE_KYC_GATE_TASK_NAME: "purchase-kyc",
    SOURCE_CONNECT_GATE_TASK_NAME: "source-connect",
}
GATE_FIXTURE_TASK_USER_IDS = {
    PURCHASE_SUBSCRIPTION_GATE_TASK_NAME: PURCHASE_SUBSCRIPTION_GATE_USER_ID,
    SUBSCRIPTION_WEBHOOK_RESUME_TASK_NAME: PURCHASE_SUBSCRIPTION_GATE_USER_ID,
    PURCHASE_SUBSCRIPTION_ADMIN_BYPASS_TASK_NAME: ADMIN_SUBSCRIPTION_BYPASS_USER_ID,
    PURCHASE_KYC_GATE_TASK_NAME: PURCHASE_KYC_GATE_USER_ID,
    SOURCE_CONNECT_GATE_TASK_NAME: SOURCE_CONNECT_GATE_USER_ID,
}
DEFAULT_MINTED_BENCHMARK_AGENT_EMAIL = "rose.harbor47@mail.roselabs.ai"
DEFAULT_MINTED_BENCHMARK_AGENT_PHONE = "+19123613984"
SMOKE_MEMORY_MAX_GROWTH_MB = float(os.environ.get("BENCHMARK_SMOKE_MEMORY_MAX_GROWTH_MB", "256"))
SMOKE_MEMORY_MAX_END_MB = float(os.environ.get("BENCHMARK_SMOKE_MEMORY_MAX_END_MB", "1800"))
SMOKE_MEMORY_MAX_WORKER_MB = float(os.environ.get("BENCHMARK_SMOKE_MEMORY_MAX_WORKER_MB", "220"))
SMOKE_MEMORY_FORBID_PLAYWRIGHT_DRIVERS = os.environ.get(
    "BENCHMARK_SMOKE_FORBID_PLAYWRIGHT_DRIVERS", "true"
).lower() not in ("0", "false", "no")


class AgentNotFoundError(Exception):
    """Raised when an agent returns 404 (deleted or expired)."""

    pass


# Terminal agent statuses
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}


def _x_post_prompt() -> str:
    """Return the X post benchmark prompt with live-session reuse guidance."""
    return f"{MINTED_AGENT_ACCOUNT_X_POST_GOAL}\n\n{MINTED_AGENT_ACCOUNT_X_AUTH_HINT}"


def _benchmark_env_bool(name: str) -> Optional[bool]:
    """Parse an optional benchmark env bool."""
    value = os.environ.get(name)
    if value is None or value == "":
        return None
    normalized = value.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"{name} must be one of true/false/1/0/yes/no/on/off")


def _resolve_write_lock_enabled(task: BenchmarkTask) -> Optional[bool]:
    """Resolve write-lock for agent create.

    Polar public-web tasks use ``approval_handling=None`` (no required gate).
    Product write-lock still pauses on Google search / form submits by default,
    which leaves the harness unable to auto-approve and stalls the suite.
    Default polar agents to write-lock off unless ``BENCHMARK_WRITE_LOCK_ENABLED``
    is set explicitly.
    """
    write_lock_enabled = _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED")
    if write_lock_enabled is None and is_polar_bench_task(task):
        return False
    return write_lock_enabled


def _minted_clear_existing_auth_enabled() -> bool:
    """Non-X minted benches clear saved realm auth unless explicitly disabled."""
    flag = _benchmark_env_bool("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH")
    return True if flag is None else flag


def _minted_x_clear_existing_auth_enabled() -> bool:
    """Live X Hello World reuses synced cookies unless explicitly forced to clear."""
    flag = _benchmark_env_bool("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH")
    return False if flag is None else flag


def _x_post_has_grounded_submission_evidence(post_text: str) -> bool:
    """Return true when the transcript grounds a submitted Hello World X post."""
    normalized = (post_text or "").lower()
    if "hello world" not in normalized:
        return False
    return any(
        marker in normalized
        for marker in (
            "posted",
            "post submitted",
            "post was submitted",
            "successfully posted",
            "published",
        )
    )


def _grade_live_x_hello_world_post(
    *,
    post_passed: bool,
    post_failure_reason: Optional[str],
    post_status: str,
    post_text: str,
) -> tuple[bool, list[str]]:
    """Grade live X Hello World: write-lock path must pass; MintedAccount is not required."""
    post_evidence = _x_post_has_grounded_submission_evidence(post_text)
    failure_parts: list[str] = []
    if not post_passed:
        failure_parts.append(f"post failed: {post_failure_reason or post_status}")
    if post_passed and not post_evidence:
        failure_parts.append("no grounded evidence that the Hello World post was submitted")
    return post_passed and post_evidence, failure_parts


def _resolved_fast_mode_cache(task: BenchmarkTask) -> Optional[bool]:
    """Resolve Fast Mode without overriding a task's side-effect safety contract."""
    if task.demo_cache == "off":
        return False
    if task.demo_cache == "on":
        return True
    return _benchmark_env_bool("BENCHMARK_FAST_MODE_CACHE")


def _reported_fast_mode_cache_enabled(task: BenchmarkTask, agent: dict) -> bool:
    """Report DEMO replay intent even when simulate forces the provider button off."""
    return agent.get("fast_mode_cache_enabled") is True or _resolved_fast_mode_cache(task) is True


def _apply_benchmark_env_overrides(tasks: List[BenchmarkTask]) -> None:
    """Apply local benchmark-only task overrides from env vars."""
    approval_override = os.environ.get("BENCHMARK_APPROVAL_HANDLING_OVERRIDE")
    if approval_override is None:
        return
    normalized = approval_override.strip().lower()
    if normalized in ("", "none", "null", "disabled", "off", "false", "0"):
        value = None
    elif normalized in ("auto_approve", "ignore", "prompt_user", "count_only"):
        value = normalized
    else:
        raise ValueError(
            "BENCHMARK_APPROVAL_HANDLING_OVERRIDE must be one of none/auto_approve/ignore/prompt_user/count_only"
        )
    for task in tasks:
        task.approval_handling = value
        print(f"  🔧 {task.name}: approval_handling overridden to {value}")


def _apply_force_show_passwords_task_overrides(tasks: List[BenchmarkTask]) -> None:
    if not _force_show_passwords_mode():
        return
    for task in tasks:
        if task.name != AMAZON_AUTH_ASSISTANCE_TASK_NAME:
            continue
        task.approval_handling = "auto_approve"
        task.expected_attention_kind = "auth_assistance"
        task.timeout_seconds = max(task.timeout_seconds, 900)
        print(
            "  🔧 browser-agent: force-show-passwords mode will auto-complete auth assistance "
            "and validate post-run credential disabling"
        )


def _contains_calendly_link(value) -> bool:
    """Return True when nested approval/message content includes a Calendly URL."""
    if isinstance(value, str):
        return "calendly.com/" in value.lower()
    if isinstance(value, dict):
        return any(_contains_calendly_link(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_calendly_link(v) for v in value)
    return False


def _normalize_attention_requests_response(data) -> list:
    """Normalize supported /api/attention-requests response shapes."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("requests"), list):
        return data["requests"]
    raise RuntimeError(f"Unexpected attention-requests response shape: {type(data).__name__}")


def _attention_request_is_open(req: dict) -> bool:
    """Return True for unanswered attention requests across API response versions."""
    if req.get("answered") is True:
        return False
    if req.get("user_response") is not None:
        return False
    if req.get("response") is not None:
        return False
    return True


def _attention_request_kind(req: dict) -> str:
    """Classify attention request metadata for typed benchmark assertions."""
    metadata = req.get("metadata") if isinstance(req, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    gate = metadata.get("gate")
    if isinstance(gate, dict) and isinstance(gate.get("type"), str):
        return f"gate:{gate['type']}"
    explicit_kind = metadata.get("attentionKind") or metadata.get("attention_kind")
    if isinstance(explicit_kind, str) and explicit_kind:
        return explicit_kind
    if isinstance(metadata.get("requestUserAuthentication"), dict) or isinstance(metadata.get("authAssistance"), dict):
        return "auth_assistance"
    if isinstance(metadata.get("requestPaymentCard"), dict):
        return "payment_approval"
    approval = metadata.get("requestUserApproval")
    if isinstance(approval, dict) and isinstance(approval.get("requestPaymentCard"), dict):
        return "payment_approval"
    if isinstance(approval, dict) and approval.get("writePermission"):
        return "write_lock"
    if metadata.get("writePermission") or metadata.get("toolApproval"):
        return "write_lock"
    if isinstance(approval, dict):
        return "approval"
    return "unknown"


def _expected_attention_kind(task: BenchmarkTask, observed_count: int) -> Optional[str]:
    alternatives = getattr(task, "expected_attention_kind_any_of", [])
    if alternatives:
        return f"exactly one of {alternatives}"
    sequence = task.expected_attention_kinds
    if sequence:
        return sequence[observed_count] if observed_count < len(sequence) else "no further attention request"
    return task.expected_attention_kind


def _attention_request_matches_task(
    task: BenchmarkTask,
    req: dict,
    observed_count: int = 0,
) -> bool:
    if task.require_attention_order:
        sequence = task.expected_attention_kinds
        if observed_count >= len(sequence) or _attention_request_kind(req) != sequence[observed_count]:
            return False
        return observed_count != 0 or not task.expected_gate or _gate_request_matches_task(task, req)
    if task.expected_gate:
        return _gate_request_matches_task(task, req)
    alternatives = getattr(task, "expected_attention_kind_any_of", [])
    if alternatives:
        return observed_count == 0 and _attention_request_kind(req) in alternatives
    if task.expected_attention_kinds and observed_count >= len(task.expected_attention_kinds):
        return False
    expected_kind = _expected_attention_kind(task, observed_count)
    if not expected_kind:
        return True
    return _attention_request_kind(req) == expected_kind


def _should_auto_approve_attention(task: BenchmarkTask, req: dict) -> bool:
    kind = _attention_request_kind(req)
    if task.complete_subscription_checkout and kind == "gate:subscription":
        return False
    return not (task.agentcard_setup_action == "complete" and kind == "agentcard_user_cardholder_onboarding_required")


def _attention_request_evidence(req: dict) -> dict:
    """Keep the user-visible approval contract for deterministic post-run checks."""
    metadata = req.get("metadata") if isinstance(req.get("metadata"), dict) else {}
    return {
        "id": req.get("id"),
        "kind": _attention_request_kind(req),
        "question": req.get("question"),
        "message": req.get("message"),
        "description": req.get("description"),
        "metadata": metadata,
    }


def _gate_request_matches_task(task: BenchmarkTask, req: dict) -> bool:
    metadata = req.get("metadata") if isinstance(req, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    gate = metadata.get("gate")
    if not isinstance(gate, dict):
        return False
    return _gate_matches_expected(task.expected_gate or {}, gate)


def _gate_matches_expected(expected: dict, gate: dict) -> bool:
    for key in ("type", "gateKey", "severity"):
        value = expected.get(key)
        if value is not None and not _expected_gate_value_matches(gate.get(key), value):
            return False
    expected_context = expected.get("context")
    if isinstance(expected_context, dict):
        context = gate.get("context") if isinstance(gate.get("context"), dict) else {}
        for key, value in expected_context.items():
            if not _expected_gate_value_matches(context.get(key), value):
                return False
    expected_detection = expected.get("detection")
    if isinstance(expected_detection, dict):
        detection = gate.get("detection") if isinstance(gate.get("detection"), dict) else {}
        for key, value in expected_detection.items():
            if not _expected_gate_value_matches(detection.get(key), value):
                return False
    return True


def _expected_gate_evidence_from_data(task: BenchmarkTask, data: dict) -> Optional[dict]:
    """Find durable expected-gate evidence in final benchmark data.

    The hot polling path observes pending attention requests via
    /api/attention-requests, but gate messages are also durably written into the
    agent transcript. Expected-gate tasks should not fail merely because the
    polling loop ended before the next attention-request fetch after the gate
    message was inserted.
    """
    if not task.expected_gate:
        return None
    expected = task.expected_gate
    benchmark_state = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    if benchmark_state.get("expected_gate_seen") is True:
        gate = benchmark_state.get("expected_gate")
        return {
            "gate": gate if isinstance(gate, dict) else expected,
            "request_id": benchmark_state.get("expected_gate_request_id"),
        }

    for request in benchmark_state.get("attention_requests_seen", []) or []:
        if not isinstance(request, dict):
            continue
        metadata = request.get("metadata") if isinstance(request.get("metadata"), dict) else {}
        gate = metadata.get("gate")
        if isinstance(gate, dict) and _gate_matches_expected(expected, gate):
            return {"gate": gate, "request_id": request.get("id")}

    for message in data.get("messages", []) or []:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            gate = candidate.get("gate")
            if not isinstance(gate, dict) or not _gate_matches_expected(expected, gate):
                continue
            return {
                "gate": gate,
                "request_id": (
                    candidate.get("attentionRequestId")
                    or candidate.get("attention_request_id")
                    or candidate.get("toolCallId")
                    or candidate.get("tool_call_id")
                ),
            }
    return None


def _mark_expected_gate_from_data(task: BenchmarkTask, data: dict) -> bool:
    evidence = _expected_gate_evidence_from_data(task, data)
    if not evidence:
        return False
    data["_benchmark"] = {
        **(data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}),
        "expected_gate_seen": True,
        "expected_gate": evidence["gate"],
        "expected_gate_request_id": evidence.get("request_id"),
    }
    return True


def _expected_gate_value_matches(actual: Any, expected: Any) -> bool:
    if isinstance(expected, list):
        return actual in expected
    return actual == expected


def _digits_only(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _phone_approval_matches_callee(task: BenchmarkTask, req: dict) -> bool:
    """Phone benchmarks may auto-approve only the active controlled callee number."""
    callee_number = getattr(task, "_callee_phone_number", "")
    if not task.phone_persona or not callee_number:
        return True
    expected_digits = _digits_only(callee_number)
    if expected_digits.startswith("1") and len(expected_digits) == 11:
        expected_digits = expected_digits[1:]
    haystack = json.dumps(req, default=str)
    haystack_digits = _digits_only(haystack)
    return bool(expected_digits and expected_digits in haystack_digits)


def _fetch_wmh_usage() -> Optional[dict]:
    """Best-effort cumulative WMH usage (cost + tokens) from the served WMH.

    The served WMH (`benchmarks.serve_world_model`) exposes `GET /rose_usage`, backed
    by the per-process accumulator every `RoseWMHProvider` step records into. Returns
    the snapshot dict (`total_cost_usd`, `input_tokens`, `output_tokens`, `calls`), or
    None when no WMH is served / it's unreachable — the report card then renders "—"
    rather than an invented number.
    """
    base = os.environ.get("WMH_BASE_URL", "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = httpx.get(f"{base}/rose_usage", timeout=5.0)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _fetch_wmh_retrieval_audit() -> Optional[dict]:
    """Best-effort exact retrieval evidence from the served WMH."""
    base = os.environ.get("WMH_BASE_URL", "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = httpx.get(f"{base}/retrieval_audit", timeout=5.0)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


@dataclass
class _WMHEvidenceSnapshot:
    """Last known-good WMH usage and grounding evidence for one bench run."""

    usage: Optional[dict] = None
    retrieval_audit: Optional[dict] = None
    _audited_calls: int = -1

    def refresh(self) -> Optional[dict]:
        current = _fetch_wmh_usage()
        if not isinstance(current, dict):
            return self.usage
        self.usage = current
        try:
            calls = int(current.get("calls") or 0)
        except (TypeError, ValueError):
            calls = 0
        if calls != self._audited_calls:
            audit = _fetch_wmh_retrieval_audit()
            if isinstance(audit, dict):
                self.retrieval_audit = audit
                self._audited_calls = calls
        return self.usage

    def finalize(self) -> Optional[dict]:
        """Refresh if possible, preserving evidence if the sidecar is gone."""
        self.refresh()
        audit = _fetch_wmh_retrieval_audit()
        if isinstance(audit, dict):
            self.retrieval_audit = audit
        return self.retrieval_audit


def _fetch_wmh_grounding_usd() -> Optional[float]:
    """WMH grounding cost (USD) — thin wrapper over `_fetch_wmh_usage`."""
    payload = _fetch_wmh_usage()
    cost = payload.get("total_cost_usd") if payload else None
    if cost is None:
        return None
    try:
        return float(cost)
    except (TypeError, ValueError):
        return None


def _infra_usd_for_elapsed(elapsed_s: float) -> Optional[float]:
    """vCPU/machine cost for `elapsed_s` at the run's per-hour rate.

    The controller (run-bench-cloud / run-bench-fleet) sets BENCHMARK_VM_USD_PER_HOUR
    from the machine size it provisioned. Absent (local runs / not on a billed VM) →
    None, so the dashboard shows "—" instead of a fabricated $0.
    """
    raw = os.environ.get("BENCHMARK_VM_USD_PER_HOUR", "").strip()
    if not raw:
        return None
    try:
        rate = float(raw)
    except (TypeError, ValueError):
        return None
    if rate <= 0:
        return None
    return round(rate * (max(0.0, float(elapsed_s)) / 3600.0), 6)


def _benchmark_context_path() -> Path:
    raw = (os.environ.get("BENCHMARK_CONTEXT_DIR") or ".context").strip() or ".context"
    if raw == "/.context" or raw.startswith("/.context/"):
        raw = raw.lstrip("/")
    path = Path(raw)
    if path.is_absolute():
        return path
    return REPO_ROOT / path


DURABLE_BENCHMARK_FRONTEND_URL = "https://roselabs.ai"


def _is_ephemeral_frontend_url(url: str) -> bool:
    """Localhost / tunnel hosts die when the stack that minted them tears down."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return True
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    return host.endswith((".ngrok.app", ".ngrok-free.app", ".trycloudflare.com", ".loca.lt"))


def _frontend_url_for_benchmark(base_url: str) -> str:
    explicit = os.environ.get("BENCHMARK_FRONTEND_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    # Production/remote runs target the public prod frontend, never a local
    # run.sh ngrok tunnel: any non-localhost base_url is a remote (prod) backend,
    # so short-circuit to roselabs.ai BEFORE consulting any local-stack signal
    # (PUBLIC_BASE_URL / services.json), which can carry a stale ngrok public URL
    # left over from a concurrent local stack and would otherwise hijack a live
    # prod run to an unreachable tunnel.
    parsed = urlparse(base_url)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return DURABLE_BENCHMARK_FRONTEND_URL
    # Stable public URL assigned by run.sh at startup (reserved ngrok domain → frontend port).
    # This is the only URL the cloud browser agent can actually reach, so prefer it over any
    # localhost fallback. run.sh exports PUBLIC_BASE_URL and records it in services.json.
    public_env = os.environ.get("PUBLIC_BASE_URL", "").strip()
    if public_env:
        return public_env.rstrip("/")
    services_path = _benchmark_context_path() / "services.json"
    if services_path.exists():
        try:
            services = json.loads(services_path.read_text())
            public_url = ((services.get("urls") or {}).get("public") or "").strip()
            if public_url:
                return public_url.rstrip("/")
        except Exception:
            pass
    conductor_port = os.environ.get("CONDUCTOR_PORT", "").strip()
    if conductor_port.isdigit():
        return f"http://localhost:{int(conductor_port) + 1}"
    if parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port:
        return f"{parsed.scheme}://{parsed.hostname}:{parsed.port + 1}"
    return DURABLE_BENCHMARK_FRONTEND_URL


def _bind_backend_api_url(base_url: str) -> None:
    """Point this process's backend client config at the backend under test.

    Declared judges lease compute tokens through ``helpers.llm`` fetchers,
    which read ``BACKEND_API_URL``. agents/.env pins that to the default dev
    stack (localhost:3001), so an isolated ``--port`` stack's judge reached a
    port nothing listens on and failed with "All connection attempts failed".
    A non-loopback value (a guest's public tunnel) is a deliberate binding and
    stays as is.
    """
    current = os.environ.get("BACKEND_API_URL", "").strip()
    if current and urlparse(current).hostname not in {"localhost", "127.0.0.1"}:
        return
    os.environ["BACKEND_API_URL"] = base_url.rstrip("/")


def _rose_api_url_for_codex_harness(base_url: str) -> str:
    """Public Rose API origin reachable from E2B (frontend dev server proxies /api)."""
    for key in ("BENCHMARK_PUBLIC_API_URL", "BACKEND_API_URL", "PUBLIC_API_URL"):
        explicit = os.environ.get(key, "").strip()
        if explicit:
            return explicit.rstrip("/")
    services_path = _benchmark_context_path() / "services.json"
    if services_path.exists():
        try:
            urls = (json.loads(services_path.read_text()) or {}).get("urls") or {}
            for field in ("backend_api", "public", "backend"):
                candidate = str(urls.get(field) or "").strip()
                if candidate:
                    return candidate.rstrip("/")
        except Exception:
            pass
    parsed = urlparse(base_url)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return base_url.rstrip("/")
    public_frontend = os.environ.get("PUBLIC_BASE_URL", "").strip()
    if public_frontend:
        return public_frontend.rstrip("/")
    if parsed.port:
        return f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
    return base_url.rstrip("/")


def _effective_harness(task: BenchmarkTask) -> str:
    override = os.environ.get("BENCHMARK_HARNESS", "").strip().lower()
    if override in {"rose", "codex"}:
        return override
    harness = getattr(task, "harness", "rose") or "rose"
    return harness if harness in {"rose", "codex"} else "rose"


def _report_frontend_url_for_benchmark(base_url: str) -> str:
    """Human-facing agent links for report cards / RCA / descend evidence.

    These links must outlive the ephemeral stack that produced the run. Prefer
    the always-on prod viewer (hub archive fallback via findAgentAcrossRuns).
    Ephemeral hosts (localhost, ngrok, trycloudflare) are rejected even when
    set via BENCHMARK_REPORT_FRONTEND_URL unless
    BENCHMARK_REPORT_ALLOW_EPHEMERAL=1 is set for an intentional live-only view.
    """
    _ = base_url  # report links are host-stable; prompt URLs use _frontend_url_for_benchmark
    explicit = os.environ.get("BENCHMARK_REPORT_FRONTEND_URL", "").strip()
    allow_ephemeral = os.environ.get("BENCHMARK_REPORT_ALLOW_EPHEMERAL", "").strip() == "1"
    if explicit:
        if allow_ephemeral or not _is_ephemeral_frontend_url(explicit):
            return explicit.rstrip("/")
    return DURABLE_BENCHMARK_FRONTEND_URL


def durable_agent_frontend_url(agent_id: str) -> str:
    """Canonical persistent FE deep link for an agent (live or hub-archived)."""
    return f"{DURABLE_BENCHMARK_FRONTEND_URL}/?agent-id={agent_id}"


def _payment_receipt_from_attention_request(req: dict) -> dict:
    metadata = req.get("metadata") if isinstance(req, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    direct = metadata.get("requestPaymentCard")
    if isinstance(direct, dict):
        return direct
    approval = metadata.get("requestUserApproval")
    if isinstance(approval, dict) and isinstance(approval.get("requestPaymentCard"), dict):
        return approval["requestPaymentCard"]
    return {}


# ---------------------------------------------------------------------------
# Shared prose matching for benchmark evaluators
#
# WHY THIS EXISTS: several evaluator assertions compare a human-readable string
# the agent copied off a live page ("Sales Tax", "The Rocky Sandwich (Half)",
# "Nopa Fish - Toast online ordering", "4821 Maplewood Dr, Austin, TX 78731")
# against a label pinned in tasks.json. NOTHING teaches the agent the pinned
# wording -- browser_tools/schemas.py documents these fields only as "Item name
# shown on the checkout page" / "Fee label shown on the checkout page" /
# "Merchant or site name" -- so a byte-for-byte comparison scores the merchant's
# copy-writing, not whether the agent completed the task. Each site used to
# hand-roll its own matching (exact dict-key equality, `casefold() ==` plus a
# bespoke `startswith("tax (")` escape hatch, a fixed via/on/through/by
# connector regex, a punctuation-squashed substring). This module-level helper
# replaces all of them with one normalizer + one token matcher.
#
# WHAT STAYS EXACT (deliberately NOT routed through here, because these are the
# real grounding for "did the agent buy the right thing, at the right price, on
# the right site"): unitPriceCents, lineTotalCents, quantity, fee amountCents,
# subtotalCents/totalCents, currency, the fingerprint hash, and the
# approval-URL host check in _validate_payment_merchant_identity.
# ---------------------------------------------------------------------------

# Street-suffix / unit abbreviations. Applied to every token: both sides of a
# comparison normalize identically, so an entry can never introduce a false
# negative -- only collapse two spellings of the same word.
_PROSE_ABBREVIATIONS = {
    "st": "street",
    "str": "street",
    "rd": "road",
    "dr": "drive",
    "drv": "drive",
    "ave": "avenue",
    "av": "avenue",
    "blvd": "boulevard",
    "ln": "lane",
    "ct": "court",
    "cir": "circle",
    "pl": "place",
    "plz": "plaza",
    "pkwy": "parkway",
    "pky": "parkway",
    "hwy": "highway",
    "sq": "square",
    "ter": "terrace",
    "trl": "trail",
    "apt": "apartment",
    "ste": "suite",
    "bldg": "building",
    "fl": "floor",
    "n": "north",
    "s": "south",
    "e": "east",
    "w": "west",
    "ne": "northeast",
    "nw": "northwest",
    "se": "southeast",
    "sw": "southwest",
}

# US state/territory abbreviations. Applied ONLY to tokens that were written as
# uppercase two-letter codes in the source ("Austin, TX"), which is how postal
# abbreviations are conventionally rendered. That guard keeps ordinary lowercase
# words like "in", "or", "me", "hi", "ok" from being rewritten as states.
_US_STATE_ABBREVIATIONS = {
    "al": "alabama",
    "ak": "alaska",
    "az": "arizona",
    "ar": "arkansas",
    "ca": "california",
    "co": "colorado",
    "ct": "connecticut",
    "de": "delaware",
    "fl": "florida",
    "ga": "georgia",
    "hi": "hawaii",
    "id": "idaho",
    "il": "illinois",
    "in": "indiana",
    "ia": "iowa",
    "ks": "kansas",
    "ky": "kentucky",
    "la": "louisiana",
    "me": "maine",
    "md": "maryland",
    "ma": "massachusetts",
    "mi": "michigan",
    "mn": "minnesota",
    "ms": "mississippi",
    "mo": "missouri",
    "mt": "montana",
    "ne": "nebraska",
    "nv": "nevada",
    "nh": "new hampshire",
    "nj": "new jersey",
    "nm": "new mexico",
    "ny": "new york",
    "nc": "north carolina",
    "nd": "north dakota",
    "oh": "ohio",
    "ok": "oklahoma",
    "or": "oregon",
    "pa": "pennsylvania",
    "ri": "rhode island",
    "sc": "south carolina",
    "sd": "south dakota",
    "tn": "tennessee",
    "tx": "texas",
    "ut": "utah",
    "vt": "vermont",
    "va": "virginia",
    "wa": "washington",
    "wv": "west virginia",
    "wi": "wisconsin",
    "wy": "wyoming",
    "dc": "district of columbia",
    "pr": "puerto rico",
}

# Filler words that carry no identity. Dropping them lets "The Rocky Sandwich"
# and "Rocky Sandwich" agree without weakening any content word.
_PROSE_STOPWORDS = frozenset({"the", "a", "an", "and", "of", "for", "with"})


def normalize_prose_tokens(value: object) -> tuple[str, ...]:
    """Casefold, strip punctuation/accents/whitespace, expand abbreviations, drop filler.

    'The Rocky  Sandwich (Half)' -> ('rocky', 'sandwich', 'half')
    '4821 Maplewood Dr, Austin, TX 78731' -> ('4821','maplewood','drive','austin','texas','78731')
    """
    if not isinstance(value, str):
        return ()
    decomposed = unicodedata.normalize("NFKD", value)
    tokens: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9]+", decomposed):
        if len(raw) == 2 and raw.isupper() and raw.casefold() in _US_STATE_ABBREVIATIONS:
            expanded = _US_STATE_ABBREVIATIONS[raw.casefold()]
        else:
            lowered = raw.casefold()
            expanded = _PROSE_ABBREVIATIONS.get(lowered, lowered)
        for token in expanded.split():
            if token not in _PROSE_STOPWORDS:
                tokens.append(token)
    return tuple(tokens)


def normalize_prose(value: object) -> str:
    """Canonical space-joined form of `value` (see normalize_prose_tokens)."""
    return " ".join(normalize_prose_tokens(value))


def prose_tokens_contain(container: object, contained: object) -> bool:
    """True when every normalized token of `contained` appears in `container`.

    Order-insensitive, so 'Sales Tax' contains 'Tax' and 'Nopa Fish ordered
    through Toast' contains 'Nopa Fish'. Empty on either side never matches.
    """
    container_tokens = set(normalize_prose_tokens(container))
    contained_tokens = set(normalize_prose_tokens(contained))
    if not container_tokens or not contained_tokens:
        return False
    return contained_tokens <= container_tokens


def prose_match_rank(expected: object, actual: object) -> Optional[tuple[int, int]]:
    """Sortable match quality between two prose strings, or None when they disagree.

    (0, 0)  identical token sets
    (1, n)  `actual` is a superset -- the page carried n extra words ('Sales Tax')
    (2, n)  `actual` is a subset -- the page carried n fewer words ('Rocky Sandwich')
    Lower sorts better, so callers pick the least-surprising candidate deterministically
    rather than the one that happens to make an amount assertion pass.
    """
    expected_tokens = set(normalize_prose_tokens(expected))
    actual_tokens = set(normalize_prose_tokens(actual))
    if not expected_tokens or not actual_tokens:
        return None
    if expected_tokens == actual_tokens:
        return (0, 0)
    if expected_tokens <= actual_tokens:
        return (1, len(actual_tokens - expected_tokens))
    if actual_tokens <= expected_tokens:
        return (2, len(expected_tokens - actual_tokens))
    return None


def best_prose_match(expected: object, candidates: List[tuple[str, object]]) -> Optional[object]:
    """Pick the best-ranked `(label, payload)` candidate for `expected`, else None."""
    ranked = [
        (rank, index, payload)
        for index, (label, payload) in enumerate(candidates)
        if (rank := prose_match_rank(expected, label)) is not None
    ]
    if not ranked:
        return None
    return min(ranked, key=lambda entry: (entry[0], entry[1]))[2]


def prose_contains_phrase(haystack: object, needle: object) -> bool:
    """True when `needle`'s normalized tokens appear contiguously inside `haystack`.

    Adjacency-preserving variant used where the pinned fact is a multi-part
    phrase (a full mailing address) and scattered tokens must not count.
    """
    normalized_needle = normalize_prose(needle)
    if not normalized_needle:
        return False
    return f" {normalized_needle} " in f" {normalize_prose(haystack)} "


def _normalize_receipt_items(receipt: dict) -> List[tuple[str, dict]]:
    """(name, amounts) pairs preserving receipt order; names matched as prose, amounts exact."""
    out: List[tuple[str, dict]] = []
    for item in receipt.get("lineItems") or receipt.get("line_items") or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        out.append(
            (
                name,
                {
                    "image_url": item.get("imageUrl")
                    or item.get("image_url")
                    or item.get("productImageUrl")
                    or item.get("product_image_url"),
                    "unit_price_cents": item.get("unitPriceCents") or item.get("unit_price_cents"),
                    "quantity": item.get("quantity"),
                    "line_total_cents": item.get("lineTotalCents") or item.get("line_total_cents"),
                },
            )
        )
    return out


def _normalize_receipt_fees(receipt: dict) -> List[tuple[str, object]]:
    """(label, amountCents) pairs preserving receipt order; labels matched as prose."""
    out: List[tuple[str, object]] = []
    for fee in receipt.get("fees") or []:
        if not isinstance(fee, dict):
            continue
        label = fee.get("label") or fee.get("name")
        if isinstance(label, str) and label:
            out.append((label, fee.get("amountCents") or fee.get("amount_cents")))
    return out


def _receipt_amount(receipt: dict, camel_key: str) -> int | None:
    snake_key = "".join([f"_{c.lower()}" if c.isupper() else c for c in camel_key]).lstrip("_")
    value = receipt.get(camel_key)
    return value if value is not None else receipt.get(snake_key)


_STRUCTURED_MERCHANT_IDENTITY = re.compile(
    r"^\s*(?P<business>.+?)\s*\(\s*(?P<platform>.+?)\s+-\s+"
    r"(?P<host>(?:[a-z0-9-]+\.)+[a-z0-9-]+)\s*\)\s*$",
    re.IGNORECASE,
)
# Catalog shorthand ``Business (host)`` without the ``Platform -`` segment (e.g.
# ``Hotels.com (hotels.com)``). Must be tried only after the structured pattern
# so ``Business (Platform - host)`` is not misread as a bare host.
_SHORTHAND_MERCHANT_IDENTITY = re.compile(
    r"^\s*(?P<business>.+?)\s*\(\s*(?P<host>(?:[a-z0-9-]+\.)+[a-z0-9-]+)\s*\)\s*$",
    re.IGNORECASE,
)
# NOTE: there is deliberately no "connected merchant" regex here any more. It only accepted the
# fixed connector vocabulary "via|on|through|by|/", which no prompt or tool schema teaches;
# free-form merchant strings are now matched with prose_tokens_contain (see above).
_NAVIGATION_ACTION_TYPES = {"goto", "navigate", "navigation"}


def _browser_action_scope(metadata: dict) -> Optional[tuple[str, str]]:
    candidates = [metadata]
    if isinstance(metadata.get("auxiliary"), dict):
        candidates.append(metadata["auxiliary"])
    scope = next(
        (
            candidate.get("subAgentId")
            or candidate.get("sub_agent_id")
            or candidate.get("task_id")
            or candidate.get("taskId")
            for candidate in candidates
            if candidate.get("subAgentId")
            or candidate.get("sub_agent_id")
            or candidate.get("task_id")
            or candidate.get("taskId")
        ),
        None,
    )
    session = next(
        (
            candidate.get("browser_session_id") or candidate.get("browser_url")
            for candidate in candidates
            if candidate.get("browser_session_id") or candidate.get("browser_url")
        ),
        None,
    )
    if not scope or not session:
        return None
    return str(scope), str(session)


def _browser_action_value(metadata: dict, *keys: str) -> object:
    candidates = [metadata]
    if isinstance(metadata.get("auxiliary"), dict):
        candidates.append(metadata["auxiliary"])
    return next(
        (candidate.get(key) for candidate in candidates for key in keys if candidate.get(key)),
        None,
    )


def _navigation_host(metadata: dict) -> Optional[str]:
    values = [
        _browser_action_value(metadata, "target_url", "current_url", "final_url", "url"),
        _browser_action_value(metadata, "title"),
    ]
    for value in values:
        if not isinstance(value, str):
            continue
        match = re.search(r"https?://[^\s<>\"']+", value)
        if not match:
            continue
        host = urlparse(match.group(0).rstrip(".,);]")).hostname
        if host:
            return host.casefold().rstrip(".")
    return None


def _grounded_payment_navigation_hosts(messages: Optional[List[dict]]) -> set[str]:
    """Return hosts from the successful payment action's exact browser flow."""
    navigations: list[tuple[int, tuple[str, str], str]] = []
    payment_actions: list[tuple[int, tuple[str, str]]] = []
    for index, message in enumerate(messages or []):
        if not isinstance(message, dict) or message.get("role") != "TOOL":
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        scope = _browser_action_scope(metadata)
        if scope is None:
            continue
        status = str(_browser_action_value(metadata, "toolStatus", "tool_status") or "").upper()
        if status != "FINISHED":
            continue
        action_type = str(_browser_action_value(metadata, "action_type") or "").casefold()
        if action_type == "request_payment_card":
            payment_actions.append((index, scope))
        elif action_type in _NAVIGATION_ACTION_TYPES:
            host = _navigation_host(metadata)
            if host:
                navigations.append((index, scope, host))
    if not payment_actions:
        return set()
    payment_index, payment_scope = max(payment_actions, key=lambda item: item[0])
    return {
        host
        for navigation_index, navigation_scope, host in navigations
        if navigation_scope == payment_scope and navigation_index <= payment_index
    }


def _payment_approval_hosts(req: dict) -> set[str]:
    """Return checkout hosts carried by the pending payment approval itself.

    Attention API payloads flatten write-lock fields onto ``metadata``
    (``url``, ``writeLockNotification``, ``requestPaymentCard``) while chat
    messages nest the same contract under ``requestUserApproval``. Read both
    shapes — bench14 agent ``abd4ae8a-…`` had ``metadata.url=
    https://checkout.eventim.us/…`` but no nested ``requestUserApproval``, so
    host grounding reported ``observed none`` despite a valid payment card.
    """
    metadata = req.get("metadata") if isinstance(req, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    approval = metadata.get("requestUserApproval")
    approval = approval if isinstance(approval, dict) else {}

    values: list[object] = [
        approval.get("url"),
        approval.get("approvalUrl"),
        metadata.get("url"),
        metadata.get("approvalUrl"),
    ]
    for notification in (
        approval.get("writeLockNotification"),
        metadata.get("writeLockNotification"),
    ):
        if not isinstance(notification, dict):
            continue
        service = notification.get("service")
        if isinstance(service, dict):
            values.extend([service.get("url"), service.get("domain")])

    hosts: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        parsed = urlparse(value if "://" in value else f"https://{value}")
        if parsed.hostname:
            hosts.add(parsed.hostname.casefold().rstrip("."))
    return hosts


def _catalog_merchant_identity(
    expected_merchant: str,
    business_aliases: object = None,
) -> tuple[list[str], Optional[str]]:
    """Parse catalog merchant bookkeeping into semantic business + platform hints."""
    structured = _STRUCTURED_MERCHANT_IDENTITY.fullmatch(expected_merchant)
    if structured is not None:
        businesses = [structured.group("business")]
        platform = structured.group("platform")
    else:
        shorthand = _SHORTHAND_MERCHANT_IDENTITY.fullmatch(expected_merchant)
        if shorthand is not None:
            businesses = [shorthand.group("business")]
            platform = shorthand.group("host")
        else:
            businesses = [expected_merchant]
            platform = None

    if isinstance(business_aliases, list):
        businesses.extend(alias for alias in business_aliases if isinstance(alias, str) and alias.strip())
    return businesses, platform


def _merchant_label_matches_businesses(actual_merchant: str, expected_businesses: list[str]) -> bool:
    return any(
        prose_match_rank(business, actual_merchant) is not None or prose_tokens_contain(actual_merchant, business)
        for business in expected_businesses
    )


def _validate_payment_merchant_identity(
    expected_merchant: object,
    actual_merchant: object,
    req: dict,
    messages: Optional[List[dict]],
    business_aliases: object = None,
) -> Optional[str]:
    """Validate business/platform/site for structured merchants without format pedantry.

    Pass/fail is: checkout host grounded + business alias and platform tokens appear
    somewhere in the merchant label. Do **not** require ``Business (Platform - host)``
    formatting — e.g. ``Eventim US (1015 Folsom)`` is fine when aliases/platform match
    and the approval is on eventim.us.
    """
    if not isinstance(expected_merchant, str) or not isinstance(actual_merchant, str):
        if actual_merchant != expected_merchant:
            return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"
        return None

    if not actual_merchant.strip():
        return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"

    expected_businesses, expected_platform = _catalog_merchant_identity(expected_merchant, business_aliases)

    # Plain catalog labels (no structured/shorthand parse) still compare semantically.
    if expected_platform is None and len(expected_businesses) == 1 and expected_businesses[0] == expected_merchant:
        if _merchant_label_matches_businesses(actual_merchant, expected_businesses):
            return None
        if actual_merchant != expected_merchant:
            return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"
        return None

    structured_actual = _STRUCTURED_MERCHANT_IDENTITY.fullmatch(actual_merchant)
    if structured_actual is not None:
        # An actual that DOES adopt the "Business (Platform - host)" convention is making an
        # explicit platform + host claim, so it is still held to that claim exactly.
        if not _merchant_label_matches_businesses(structured_actual.group("business"), expected_businesses):
            return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"
        if (
            expected_platform is not None
            and prose_match_rank(expected_platform, structured_actual.group("platform")) is None
        ):
            return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"
    elif not _merchant_label_matches_businesses(actual_merchant, expected_businesses):
        # The request_payment_card schema only asks for a "Merchant or site name", so ANY free-form
        # phrasing that carries the expected business ("Nopa Fish", "Nopa Fish via Toast", "Nopa
        # Fish — Toast online ordering") is a legitimate emission; the "Business (Platform - host)"
        # wording is benchmark bookkeeping that is never taught to the agent, and the old fixed
        # via/on/through/by connector vocabulary is not taught either.
        return f"merchant mismatch: expected {expected_merchant}, got {actual_merchant}"

    # URL matching is deliberately absent. Comparing the approval-URL host against an
    # expected host was the last URL string match in this evaluator; it is removed by
    # decision, so the merchant assertion rests on the business name alone. A run that
    # transacts with the right-named business on a different site now scores as a pass.
    return None


def _validate_payment_receipt(
    task: BenchmarkTask,
    req: dict,
    *,
    messages: Optional[List[dict]] = None,
) -> Optional[str]:
    expected = task.expected_payment_receipt
    if not expected:
        return None
    receipt = _payment_receipt_from_attention_request(req)
    if not receipt:
        return "missing requestPaymentCard metadata"

    # Catalog `expected_payment_receipt: true` means "any well-formed payment-card request"
    # (e.g. gate-subscription-card-mint-admin-bypass). Calling `.get` on the bool raised
    # AttributeError, which the poll loop swallowed as "Approval check error" and delayed
    # auto-approve + never set expected_payment_receipt_seen on that first sighting.
    if expected is True:
        return None
    if not isinstance(expected, dict):
        return f"invalid expected_payment_receipt type: {type(expected).__name__}"

    required_fields = expected.get("requiredFields", [])
    for field in required_fields:
        if field not in receipt:
            return f"missing required payment receipt field: {field}"
        if field != "fees" and receipt.get(field) in (None, "", []):
            return f"empty required payment receipt field: {field}"

    required_line_item_fields = expected.get("requiredLineItemFields", [])
    line_items = receipt.get("lineItems")
    if required_line_item_fields and not isinstance(line_items, list):
        return "missing required payment receipt field: lineItems"
    for item_index, item in enumerate(line_items or []):
        if not isinstance(item, dict):
            return f"payment receipt lineItems[{item_index}] must be an object"
        for field in required_line_item_fields:
            if field not in item:
                return f"missing required lineItems[{item_index}] field: {field}"
            if field != "imageUrl" and item.get(field) in (None, "", []):
                return f"empty required lineItems[{item_index}] field: {field}"

    required_fee_fields = expected.get("requiredFeeFields", [])
    fees = receipt.get("fees")
    if required_fee_fields and not isinstance(fees, list):
        return "missing required payment receipt field: fees"
    for fee_index, fee in enumerate(fees or []):
        if not isinstance(fee, dict):
            return f"payment receipt fees[{fee_index}] must be an object"
        for field in required_fee_fields:
            if field not in fee:
                return f"missing required fees[{fee_index}] field: {field}"
            if fee.get(field) in (None, ""):
                return f"empty required fees[{fee_index}] field: {field}"

    if required_fields or required_line_item_fields or required_fee_fields:
        from browser_tools.schemas import RequestPaymentCardBrowserTool

        try:
            RequestPaymentCardBrowserTool.model_validate({"tool": "request_payment_card", **receipt})
        except ValueError as exc:
            return f"malformed complete payment receipt: {exc}"
        fingerprint = receipt.get("fingerprint")
        if "fingerprint" in required_fields and (
            not isinstance(fingerprint, str) or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None
        ):
            return "malformed complete payment receipt field: fingerprint"
    if "merchant" in expected:
        merchant_error = _validate_payment_merchant_identity(
            expected.get("merchant"),
            receipt.get("merchant"),
            req,
            messages,
            expected.get("merchantBusinessAliases"),
        )
        if merchant_error:
            return merchant_error
    if "currency" in expected and (receipt.get("currency") or "USD") != expected.get("currency", "USD"):
        return f"currency mismatch: expected {expected.get('currency', 'USD')}, got {receipt.get('currency')}"
    for key in ("subtotalCents", "totalCents"):
        if key not in expected:
            continue
        actual_amount = _receipt_amount(receipt, key)
        if actual_amount != expected.get(key):
            return f"{key} mismatch: expected {expected.get(key)}, got {actual_amount}"

    actual_items = _normalize_receipt_items(receipt)
    for expected_item in expected.get("lineItems", []):
        name = expected_item.get("name")
        # The tool schema documents `name` only as "Item name shown on the checkout page",
        # so the pinned wording is benchmark bookkeeping, not a taught format: match the
        # name as prose. Every amount below still compares EXACTLY.
        actual = best_prose_match(name, actual_items)
        if not actual:
            return f"missing receipt line item: {name}"
        for actual_key, expected_key in (
            ("image_url", "imageUrl"),
            ("unit_price_cents", "unitPriceCents"),
            ("quantity", "quantity"),
            ("line_total_cents", "lineTotalCents"),
        ):
            if expected_key not in expected_item:
                continue
            if actual.get(actual_key) != expected_item.get(expected_key):
                return (
                    f"{name} {expected_key} mismatch: "
                    f"expected {expected_item.get(expected_key)}, got {actual.get(actual_key)}"
                )

    actual_fees = _normalize_receipt_fees(receipt)
    for expected_fee in expected.get("fees", []):
        # The tool schema documents `label` only as "Fee label shown on the checkout page"
        # and gives no vocabulary, so "Sales Tax"/"Tax (8.25%)"/"Estimated Tax" are all
        # legitimate renderings of a pinned "Tax". The general prose rule subsumes the old
        # bespoke `startswith("tax (")` escape hatch, which is now deleted. amountCents
        # still compares EXACTLY.
        actual_fee = best_prose_match(expected_fee.get("label", ""), actual_fees)
        if actual_fee != expected_fee.get("amountCents"):
            return (
                f"{expected_fee.get('label')} fee mismatch: "
                f"expected {expected_fee.get('amountCents')}, got {actual_fee}"
            )
    return None


def _validate_payment_lifecycle(task: BenchmarkTask, data: dict) -> Optional[str]:
    expected = task.expected_payment_lifecycle
    if not expected:
        return None
    benchmark_state = data.get("_benchmark", {})
    actual = benchmark_state.get("payment_lifecycle")
    if not isinstance(actual, dict):
        detail = benchmark_state.get("payment_lifecycle_error")
        return f"missing payment lifecycle snapshot{f': {detail}' if detail else ''}"

    if task.production_only:
        for section, field in (("stripeHold", "livemode"), ("stripeRefund", "paymentIntentLivemode")):
            if isinstance(expected.get(section), dict):
                observed = actual.get(section)
                if not isinstance(observed, dict) or observed.get(field) is not True:
                    return f"payment_lifecycle.{section}.{field} must be true for a production lifecycle"

    def compare(expected_value, actual_value, path: str) -> Optional[str]:
        if isinstance(expected_value, dict):
            if not isinstance(actual_value, dict):
                return f"{path} mismatch: expected object, got {actual_value!r}"
            for key, nested_expected in expected_value.items():
                if key not in actual_value:
                    return f"{path}.{key} missing from payment lifecycle"
                error = compare(nested_expected, actual_value[key], f"{path}.{key}")
                if error:
                    return error
            return None
        # Merchant labels are free-form ("Rose Labs Test Payment (ngrok test
        # checkout)" vs catalog "Rose Labs Test Payment"). Reuse the payment
        # identity matcher so parenthetical environment suffixes do not fail a
        # successful purchase lifecycle.
        if path.endswith(".merchant"):
            identity_error = _validate_payment_merchant_identity(expected_value, actual_value, {}, None)
            if identity_error is None:
                return None
            return f"{path} mismatch: expected {expected_value!r}, got {actual_value!r}"
        if expected_value != actual_value:
            return f"{path} mismatch: expected {expected_value!r}, got {actual_value!r}"
        return None

    return compare(expected, actual, "payment_lifecycle")


CLAUDE_CODE_CREDENTIAL_SKIP_REASON = (
    "Claude Code credentials unavailable: no synced Claude token and no available pool token"
)
CODEX_HARNESS_CREDENTIAL_SKIP_REASON = (
    "Codex harness credentials unavailable: no synced GPT compute token and no funded Azure Codex deployment"
)


COMPUTE_TOKEN_UNAVAILABLE_SKIP_REASON = "Compute token pool exhausted or cooling down"


class ComputeTokenUnavailable(RuntimeError):
    """No shared compute token is leasable for a benchmark-owned consumer right now.

    The shared token pool is exhausted or every token is in a provider cooldown.
    That is a skipped test under the standing user decision, not an infra failure
    or a task verdict: it counts toward neither the infra stop nor pass/fail.
    """


def _is_permitted_compute_token_skip(result: TaskResult) -> bool:
    return result.status == "SKIPPED" and (result.failure_reason or "").startswith(
        COMPUTE_TOKEN_UNAVAILABLE_SKIP_REASON
    )


def _codex_harness_credential_skip_result(task: BenchmarkTask) -> TaskResult:
    return TaskResult(
        name=task.name,
        passed=False,
        agent_id="",
        status="SKIPPED",
        benchmark_status="SKIPPED",
        progress_score=0,
        duration_seconds=0,
        cost_cents=0,
        message_count=0,
        failure_reason=CODEX_HARNESS_CREDENTIAL_SKIP_REASON,
    )


def _claude_code_credential_skip_result(task: BenchmarkTask) -> TaskResult:
    """Build the one deploy-approved provider-credential skip result."""
    return TaskResult(
        name=task.name,
        passed=False,
        agent_id="",
        status="SKIPPED",
        benchmark_status="SKIPPED",
        progress_score=0,
        duration_seconds=0,
        cost_cents=0,
        message_count=0,
        failure_reason=CLAUDE_CODE_CREDENTIAL_SKIP_REASON,
    )


def _is_permitted_claude_code_skip(result: TaskResult) -> bool:
    """Return whether a skipped task is the deploy-approved Claude credential skip.

    Generic CI remains strict: skipped required benchmarks fail the gate. The only
    deploy-approved exception is a Claude Code task whose provider credential path
    is unavailable before launch. That external auth/funding state is covered by
    credential-health and must not force a human approval loop for every deploy.
    """
    if result.status != "SKIPPED":
        return False
    try:
        task = get_task_by_name(result.name)
    except Exception:
        return False
    return bool(task.requires_claude_code and result.failure_reason == CLAUDE_CODE_CREDENTIAL_SKIP_REASON)


def _ci_should_fail(summary: dict, task_results: list[TaskResult] | None = None) -> bool:
    """CI fails on failed tasks and on skipped tasks unless explicitly permitted."""
    if summary.get("failed", 0) > 0:
        return True
    # Unverified owned-resource cleanup fails CI without rewriting any task verdict.
    if summary.get("cleanup_failures", 0) > 0 or any(
        getattr(result, "cleanup_failure", None) for result in (task_results or [])
    ):
        return True
    skipped = summary.get("skipped", 0)
    if skipped <= 0:
        return False
    if task_results is None:
        return True
    skipped_results = [result for result in task_results if result.status == "SKIPPED"]
    return any(
        not (
            _is_permitted_claude_code_skip(result)
            or _is_permitted_agentcard_release_skip(result)
            or _is_permitted_compute_token_skip(result)
        )
        for result in skipped_results
    )


AGENTCARD_RELEASE_SKIP_ENV = "BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL"
AGENTCARD_RELEASE_SKIP_REASON = (
    "AgentCard never released the closed card's org transfer (consumed, releasedCents=0); "
    "skipped under the standing user-approved warning policy, see "
    "docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md"
)


class AgentCardReleaseStall(RuntimeError):
    """AgentCard left a closed card's transfer consumed while Rose waits to reclaim it."""

    def __init__(self, message: str, *, lifecycle: dict | None = None):
        super().__init__(message)
        self.lifecycle = lifecycle


def _agentcard_release_skip_enabled() -> bool:
    # Permanent for local, cloud and production runs; no deploy-specific opt-in.
    # An explicit 0 remains available for investigating the unresolved release.
    return os.environ.get(AGENTCARD_RELEASE_SKIP_ENV, "1") == "1"


def _agentcard_release_skip_task(task_name: str | None) -> bool:
    """The release waiver belongs to catalog AgentCard lifecycle tasks in either mode."""
    try:
        task = get_task_by_name(task_name)
    except ValueError:
        return False
    lifecycle = task.expected_payment_lifecycle
    transfer = lifecycle.get("orgTransfer") if isinstance(lifecycle, dict) else None
    if not isinstance(transfer, dict):
        return False
    return (
        task.production_only is False
        and "agentcard-lifecycle-sandbox" in task.tags
        and transfer.get("livemode") is False
    ) or (
        task.production_only is True
        and "agentcard-lifecycle-production" in task.tags
        and transfer.get("livemode") is True
    )


def _agentcard_release_stalled(lifecycle: object, *, livemode: bool = False) -> bool:
    """AgentCard's release of a closed card's transfer is outstanding in the expected mode.

    Rose has closed the card and is reclaiming; AgentCard still reports this card's
    transfer as consumed with nothing released. Cross-mode observations never match.
    """
    if not isinstance(lifecycle, dict):
        return False
    purchase = lifecycle.get("purchase")
    funding = lifecycle.get("walletFunding")
    card = lifecycle.get("agentCard")
    transfer = lifecycle.get("orgTransfer")
    return (
        isinstance(purchase, dict)
        and purchase.get("status") == "HELD"
        and isinstance(funding, dict)
        and funding.get("status") == "RECLAIMING"
        and isinstance(card, dict)
        and card.get("status") == "CLOSED"
        and card.get("balanceCents") == 0
        and not isinstance(card.get("balanceCents"), bool)
        and isinstance(card.get("id"), str)
        and bool(card["id"].strip())
        and purchase.get("cardId") == card["id"]
        and isinstance(transfer, dict)
        and isinstance(transfer.get("id"), str)
        and bool(transfer["id"].strip())
        and funding.get("providerTransferId") == transfer["id"]
        and transfer.get("cardId") == card["id"]
        and transfer.get("status") == "consumed"
        and transfer.get("livemode") is livemode
        and transfer.get("releasedCents") == 0
        and not isinstance(transfer.get("releasedCents"), bool)
        and "stripeRefund" in lifecycle
        and lifecycle["stripeRefund"] is None
    )


def _agentcard_release_skip_lifecycle(task_name: str | None, lifecycle: object) -> bool:
    """Waive only settlement fields; every independent catalog assertion still holds.

    Native lifecycle -> exact closed-card stall -> unchanged independent checks
      -> warning SKIP; any other mismatch -> normal failure.
    The filtered contract is local validation only; native evidence is never rewritten.
    """
    if not _agentcard_release_skip_task(task_name):
        return False
    task = get_task_by_name(task_name)
    if not _agentcard_release_stalled(lifecycle, livemode=task.production_only):
        return False
    pending_fields = {
        "purchase": {"status"},
        "walletFunding": {"status"},
        "orgTransfer": {"status", "transferredCents", "releasedCents"},
    }
    contract = dict(task.expected_payment_lifecycle)
    contract.pop("stripeRefund", None)
    for section, fields in pending_fields.items():
        if isinstance(contract.get(section), dict):
            contract[section] = {key: value for key, value in contract[section].items() if key not in fields}
    return _validate_payment_lifecycle(
        replace(task, expected_payment_lifecycle=contract), {"_benchmark": {"payment_lifecycle": lifecycle}}
    ) is None


def _agentcard_release_prior_failure_is_settlement_only(
    task_name: str | None, reason: str | None, lifecycle: object
) -> bool:
    """Permit a prior verdict only when it is this same pending settlement.

    The task can finish while the purchase is still HELD, setting an evaluation
    failure before cleanup closes the card. The later exact native stall proof
    must be allowed to classify that one mismatch, but never a separate failure.
    """
    if not _agentcard_release_skip_lifecycle(task_name, lifecycle):
        return False
    if reason is None:
        return True
    task = get_task_by_name(task_name)
    native_error = _validate_payment_lifecycle(
        task, {"_benchmark": {"payment_lifecycle": lifecycle}}
    )
    settlement_fields = (
        "payment_lifecycle.purchase.status mismatch:",
        "payment_lifecycle.walletFunding.status mismatch:",
        "payment_lifecycle.orgTransfer.status mismatch:",
        "payment_lifecycle.orgTransfer.transferredCents mismatch:",
        "payment_lifecycle.orgTransfer.releasedCents mismatch:",
    )
    return reason == native_error and reason.startswith(settlement_fields)


def _is_permitted_agentcard_release_skip(result: TaskResult) -> bool:
    return (
        result.status == "SKIPPED"
        and _agentcard_release_skip_task(result.name)
        and _agentcard_release_skip_enabled()
        and (result.failure_reason or "").startswith(AGENTCARD_RELEASE_SKIP_REASON)
    )


def _warn_agentcard_release_skip(name: str, detail: str) -> None:
    print(
        f"\n    ⚠️⚠️ SKIPPED {name}: {AGENTCARD_RELEASE_SKIP_REASON}\n"
        f"    ⚠️⚠️ Funds remain unreleased and any Stripe refund remains pending: {detail}"
    )


def _apply_world_model_cli_env(args, parser: argparse.ArgumentParser) -> None:
    """Apply WMH benchmark flags to env vars consumed by workers and eval."""

    if args.simulate and args.world_model_mode and args.world_model_mode != "simulate":
        parser.error("--simulate conflicts with --world-model-mode values other than simulate")
    world_model_mode = "simulate" if args.simulate else args.world_model_mode
    if world_model_mode:
        os.environ["BENCHMARK_WORLD_MODEL_MODE"] = world_model_mode
    if world_model_mode == "simulate":
        if not os.environ.get("WMH_MODEL_NAME") and not args.world_model_name:
            os.environ["WMH_MODEL_NAME"] = "rose-archive"
        if not os.environ.get("TRACE_ARCHIVE_BACKEND") and all(
            os.environ.get(name)
            for name in (
                "R2_ACCOUNT_ID",
                "R2_ACCESS_KEY_ID",
                "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET_TRACE_ARCHIVE",
            )
        ):
            os.environ["TRACE_ARCHIVE_BACKEND"] = "r2"
            os.environ.setdefault("TRACE_ARCHIVE_ENABLED", "1")
    if args.wmh_eval or world_model_mode == "shadow":
        os.environ["BENCHMARK_WMH_EVAL"] = "1"
    if args.world_model_url:
        os.environ["WMH_BASE_URL"] = args.world_model_url
    if args.world_model_name:
        os.environ["WMH_MODEL_NAME"] = args.world_model_name
    if args.world_model_session_id:
        os.environ["WMH_SESSION_ID"] = args.world_model_session_id


def _world_model_mode_from_args(args) -> str | None:
    return "simulate" if args.simulate else args.world_model_mode


def _format_world_model_progress(event: dict[str, Any]) -> str:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    counts = []
    for key in (
        "total_traces",
        "traces_to_update",
        "updated_traces",
        "traces_unchanged",
        "unchanged_traces",
        "artifact_count",
        "exported_spans",
        "index_refresh_required",
        "indexed_traces",
        "indexed_steps",
        "aggregate_trace_bytes",
        "replay_corpus_bytes",
        "elapsed_ms",
    ):
        if key in metadata:
            counts.append(f"{key}={metadata[key]}")
    suffix = f" ({', '.join(counts)})" if counts else ""
    return f"  🌌 {event.get('title')}: {event.get('status')}{suffix}"


def _record_world_model_progress(event: dict[str, Any]) -> None:
    _WORLD_MODEL_UPDATE_EVENTS.append(event)
    print(_format_world_model_progress(event), flush=True)


async def _update_world_model_before_simulation(args) -> None:
    global _WORLD_MODEL_UPDATE_RESULT
    if _world_model_mode_from_args(args) != "simulate":
        return
    # When the WMH is already served (run.sh builds + serves the model and exports
    # WMH_BASE_URL, which local.py injects here), that served model is authoritative.
    # Rebuilding/refreshing the corpus from R2 in-process would be redundant work and
    # could target a different build dir — defer to the served model instead.
    if os.environ.get("WMH_BASE_URL"):
        print("\n  World model already served (WMH_BASE_URL set) — skipping pre-run corpus update.")
        return
    _WORLD_MODEL_UPDATE_EVENTS.clear()
    print("\n  Updating world model before simulated benchmark run...")
    try:
        _WORLD_MODEL_UPDATE_RESULT = await asyncio.to_thread(
            update_world_model_for_simulation,
            name=os.environ.get("WMH_MODEL_NAME") or args.world_model_name or "rose-archive",
            provider=os.environ.get("WMH_BUILD_PROVIDER") or "anthropic",
            model=os.environ.get("WMH_BUILD_MODEL") or os.environ.get("WMH_SERVE_MODEL") or "claude-opus-4-8",
            progress=_record_world_model_progress,
        )
    except Exception as exc:
        print(f"  ❌ World model update failed before simulate run: {exc}")
        raise
    if _WORLD_MODEL_UPDATE_RESULT:
        os.environ["WMH_MODEL_NAME"] = str(
            _WORLD_MODEL_UPDATE_RESULT.get("model_name") or os.environ.get("WMH_MODEL_NAME") or "rose-archive"
        )
        print(
            "  ✅ World model ready: "
            f"total={_WORLD_MODEL_UPDATE_RESULT.get('total_traces')} "
            f"updated={_WORLD_MODEL_UPDATE_RESULT.get('updated_traces')} "
            f"unchanged={_WORLD_MODEL_UPDATE_RESULT.get('unchanged_traces')} "
            f"build_ran={_WORLD_MODEL_UPDATE_RESULT.get('build_ran')}"
        )


def _extract_agent_payment_output_blob(data: dict) -> str:
    """Collect terminal browser output — key-agnostic — as a JSON blob for semantic judging.

    Prefer populated structured responses. When a completed browser task used its user-message
    terminal path, the manager has no structured metadata even though the same grounded result is
    preserved in the terminal tool message; retain that text as the fallback evidence channel.
    """
    blobs: List[dict] = []
    for message in data.get("messages", []) or []:
        if not isinstance(message, dict) or message.get("role") != "TOOL":
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "spawn_browser_agent" or metadata.get("toolStatus") != "FINISHED":
            continue
        structured = metadata.get("structured_response") or metadata.get("structuredResponse")
        if isinstance(structured, dict):
            blobs.append(structured)
            continue
        message_text = message.get("message")
        if metadata.get("action_type") == "task_complete" and isinstance(message_text, str) and message_text.strip():
            blobs.append({"browser_result_text": message_text})
    return json.dumps(blobs, default=str) if blobs else ""


# Grounded test-payment confirmation ids are always `tp_` + exactly 8 lowercase hex chars.
# Matching this in the populated browser output is sufficient for the shop contract; the LLM
# judge exists only for key-name-agnostic recovery when the id is present under an unexpected
# shape that a regex might miss. Prefer the deterministic check so a successful checkout cannot
# false-fail when the judge waterfall is out of credits (OpenAI/Anthropic/OpenRouter 402).
_AGENT_PAYMENT_CONFIRMATION_ID_RE = re.compile(r"\btp_[0-9a-f]{8}\b")


def agent_payment_blob_has_grounded_confirmation_id(blob: str) -> bool:
    """True when the agent output already contains a grounded tp_<8 hex> confirmation id."""
    return bool(_AGENT_PAYMENT_CONFIRMATION_ID_RE.search(blob or ""))


async def validate_agent_payment_confirmation_contract(data: dict, root_agent_id: str) -> Optional[str]:
    """Semantic gate for the payment lifecycle's browser-purchase step. The browser agent's populated
    output must let the STANDARD semantic output judge recover a grounded payment confirmation id
    (tp_<8 hex>) under ANY key name. Replaces the old exact-key (order_confirmation_id /
    payment_confirmation_id) match that failed genuinely-successful runs whose LLM-synthesized schema
    emitted the id under `order_id` instead. Returns None on pass, else the failure reason."""
    blob = _extract_agent_payment_output_blob(data)
    if not blob:
        return "agent did not return a grounded browser payment confirmation order id"
    if agent_payment_blob_has_grounded_confirmation_id(blob):
        return None
    return await _judge_output_recovers_expected_fields(
        root_agent_id,
        blob,
        SEMANTIC_OUTPUT_EXPECTATIONS["agent-payment"],
        AGENT_PAYMENT_TEST_SHOP_TASK_NAME,
    )


def _missing_final_findings(findings: List[str], haystack: str) -> List[str]:
    """expected_final_findings the agent's final answer failed to report.

    `expected_final_findings` pins prose facts (a full mailing address) that the agent only ever
    heard spoken aloud on a phone call; nothing tells it to echo the benchmark's exact spelling, so
    "4821 Maplewood Dr, Austin, TX 78731" is the same fact as "4821 Maplewood Drive, Austin, Texas
    78731". `missing_call_findings` (punctuation-squashed substring, spoken-digit aware) is tried
    first and its acceptances are preserved verbatim; anything it rejects gets a second, purely
    deterministic chance via the shared prose normalizer, which expands street-suffix and state
    abbreviations. Adjacency is preserved (prose_contains_phrase, not token-set containment), so a
    wrong street number/name/zip -- or the right words scattered across unrelated sentences --
    still fails.
    """
    return [
        finding for finding in missing_call_findings(findings, haystack) if not prose_contains_phrase(haystack, finding)
    ]


async def _evaluate_phone_call_task(
    task: BenchmarkTask,
    data: dict,
    callee: PhoneCalleeSession,
    *,
    base_url: str,
    agent_id: str,
) -> tuple[bool, str | None]:
    """Two-sided phone verification: agent-side findings + callee-side analysis + FE playback."""
    pinned_findings = _flatten_pinned_call_findings(task.pinned_facts)
    expected_findings = [*(task.expected_call_findings or []), *pinned_findings]
    missing = missing_call_findings(expected_findings, phone_search_text(data))
    if missing:
        return False, f"agent output missing pinned/expected call findings: {missing}"
    final_missing = _missing_final_findings(task.expected_final_findings or [], phone_final_result_text(data))
    if final_missing:
        return False, f"final output missing expected returned findings: {final_missing}"
    if task.callee_checks:
        try:
            structured = await callee.fetch_callee_structured_data(timeout_seconds=callee.analysis_timeout_seconds())
        except Exception as exc:
            return False, f"failed to fetch callee-side call analysis: {exc}"
        failures = callee_check_failures(task.callee_checks, structured)
        if failures:
            return False, "callee-side checks failed: " + "; ".join(failures)
    playback_failures = await phone_recording_playback_failures(
        data,
        base_url=base_url,
        agent_id=agent_id,
        headers=await _api_headers(),
    )
    if playback_failures:
        return False, "FE phone recording playback failed: " + "; ".join(playback_failures)
    return True, None


def phone_final_result_text(data: dict) -> str:
    """Final returned data only; excludes prompts and raw phone transcript metadata."""
    chunks: list[str] = []
    for message in data.get("messages", []) or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        tool_name = metadata.get("toolName") if isinstance(metadata, dict) else None
        if tool_name in {"attempt_completion", "completion_summary"}:
            chunks.append(str(message.get("text") or message.get("message") or ""))
            completion_summary = metadata.get("completionSummary") if isinstance(metadata, dict) else None
            if isinstance(completion_summary, dict):
                chunks.append(json.dumps(completion_summary))
        elif message.get("role") == "ASSISTANT":
            chunks.append(str(message.get("text") or message.get("message") or ""))
    return "\n".join(chunks)


def phone_parked_hold_seconds(data: dict) -> int:
    """Longest wait_for_human parking reported on a finished call_phone_number card."""
    parked = 0
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict) or metadata.get("toolName") != "call_phone_number":
            continue
        phone_call = metadata.get("phoneCall")
        hold_seconds = phone_call.get("holdSeconds") if isinstance(phone_call, dict) else None
        if isinstance(hold_seconds, int) and not isinstance(hold_seconds, bool):
            parked = max(parked, hold_seconds)
    return parked


def _flatten_pinned_call_findings(pinned_facts: Optional[dict]) -> list[str]:
    """Return string leaves from pinned phone facts for agent-side evidence checks."""
    findings: list[str] = []

    def visit(value: object) -> None:
        if isinstance(value, dict):
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)
        elif isinstance(value, (str, int, float)) and str(value).strip():
            findings.append(str(value))

    visit(pinned_facts or {})
    return findings


def _default_timeout_for_task(task: BenchmarkTask, max_seconds: int | None = None) -> int:
    """Return the configured timeout used when dynamic history is unavailable."""
    timeout = task.timeout_seconds
    if max_seconds is not None:
        timeout = min(timeout, max_seconds)
    floor = get_timeout_floor(task.name)
    return max(timeout, floor) if floor else timeout


def resolve_task_execution_timeout(task: BenchmarkTask, *, bootstrap: bool = False) -> tuple[int, str]:
    """Resolve one task's execution timeout and a short provenance note.

    The benchmark definition (catalog timeout, smoke cap, floor) is the minimum.
    Recent pass history may extend it within the smoke cap but never shortens
    it; only an explicit operator cap (--timeout /
    BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS) may stop a task earlier.
    """
    cap = get_smoke_cap(task.name)
    seconds = _default_timeout_for_task(task, cap)
    s = _history_summary(task.name, max_seconds=cap)
    note = f"{'bootstrap; ' if bootstrap else ''}benchmark timeout; recent_p95={s['recent_p95']}s, n={s['count']}"
    if bootstrap:
        return seconds, note
    try:
        history_timeout = _history_get_timeout(task.name, max_seconds=cap)
    except InsufficientHistoryError:
        return seconds, note
    floor = get_timeout_floor(task.name)
    history_timeout = max(history_timeout, floor) if floor else history_timeout
    if history_timeout > seconds:
        return (
            history_timeout,
            f"history extends the {seconds}s benchmark timeout; recent_p95={s['recent_p95']}s, n={s['count']}",
        )
    return seconds, note


# ============================================================
# API helpers
# ============================================================

_cached_headers: Optional[dict] = None
_cached_headers_user_id: Optional[str] = None
_auth_mode: Optional[str] = None  # "jwt" or "api_key"
_subscription_webhook_stripe_customers: Dict[str, str] = {}
# Per-task run identity. Concurrent tasks share one process, so a process-wide
# env var lets a finishing sibling restore its stale snapshot over a live task's
# identity; a ContextVar is copied into each asyncio task instead.
_task_run_user_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "benchmark_task_run_user_id", default=None
)


_owned_cleanup_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "owned_cleanup_user_id", default=None
)


_task_root_custody: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("benchmark_task_root_custody", default=None)


def _register_task_root(task_name: str, root_id: str, role: str) -> Optional[dict]:
    custody = _task_root_custody.get()
    if custody is None:
        return None
    if custody["task_name"] != task_name or role not in {"fixture_first_run", "graded"}:
        raise RuntimeError("foreign task root custody")
    try:
        valid = isinstance(root_id, str) and str(uuid.UUID(root_id)) == root_id
    except ValueError:
        valid = False
    if not valid or any(row["root_agent_id"] == root_id for row in custody["roots"]):
        raise RuntimeError("unknown or duplicate task root allocation")
    row = {"root_agent_id": root_id, "task_name": task_name, "role": role,
           "creation": {"source": "create_agent_return", "root_agent_id": root_id},
           "stage_outcome": "created", "logs": {}}
    custody["roots"].append(row)
    if role == "graded":
        custody["graded_creation"] = "allocated"
    if custody["callback"]:
        custody["callback"](task_name, root_id)
    return row


def _bind_task_root_custody(result: TaskResult, custody: dict) -> TaskResult:
    for root in custody["roots"]:
        if root["role"] == "graded" and root["root_agent_id"] == result.agent_id:
            root["stage_outcome"] = result.benchmark_status or result.status
            root["logs"] = result.logs if isinstance(result.logs, dict) else {}
    result.owned_roots = custody["roots"]
    result.graded_root_creation_outcome = custody["graded_creation"]
    return result


def _current_benchmark_user_id() -> str:
    return (
        _owned_cleanup_user_id.get()
        or _task_run_user_id.get()
        or os.environ.get("BENCHMARK_RUN_USER_ID", "").strip()
        or USER_ID
    )


@contextmanager
def _benchmark_run_user_scope(user_id: Optional[str]) -> Iterator[None]:
    if not user_id:
        yield
        return
    token = _task_run_user_id.set(user_id)
    try:
        yield
    finally:
        _task_run_user_id.reset(token)


def _new_user_payment_journey_user_id() -> str:
    """Give each isolated run a fresh account and Stripe Checkout idempotency scope."""
    run_scope = os.environ.get("BENCHMARK_RUN_ID", "").strip()
    if not run_scope:
        context_dir = os.environ.get("BENCHMARK_CONTEXT_DIR", "").strip()
        if context_dir and context_dir != ".context":
            run_scope = str(Path(context_dir).resolve())
    if not run_scope:
        raise RuntimeError("New-user payment journey requires an isolated benchmark run ID")
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"rose-new-user-payment:{run_scope}"))


def _benchmark_user_id_for_task(task_name: str, base_url: Optional[str] = None) -> Optional[str]:
    """Return a task-scoped synthetic identity, leaving ordinary and production tasks unchanged."""
    if task_name == FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME:
        return _free_credit_subscription_gate_user_id()
    if task_name == ROSE_SHOP_NO_SUBSCRIPTION_TASK_NAME:
        # A new account every lane: the first lane's Checkout subscribes its user,
        # so a shared user would start every later lane already subscribed.
        return str(uuid.uuid4()) if base_url is None or _is_local_base_url(base_url) else None
    if task_name == NEW_USER_PAYMENT_JOURNEY_TASK_NAME:
        return _new_user_payment_journey_user_id() if base_url is None or _is_local_base_url(base_url) else None
    if task_name in GATE_FIXTURE_TASK_USER_IDS:
        return GATE_FIXTURE_TASK_USER_IDS[task_name]
    if task_name in AGENT_PAYMENT_SANDBOX_TASK_NAMES:
        if base_url is not None and not _is_local_base_url(base_url):
            return None
        # Sandbox lifecycle benches run as the default admin account. The backend
        # keeps admin credits (unlimited) and BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH
        # forces the charged Stripe-hold mint path.
        return os.environ.get(AGENT_PAYMENT_BENCHMARK_USER_ID_ENV, "").strip() or AGENT_PAYMENT_BENCHMARK_USER_ID
    return None


def _free_credit_subscription_gate_user_id() -> str:
    return (
        os.environ.get("BENCHMARK_FREE_CREDIT_SUBSCRIPTION_GATE_USER_ID", "").strip()
        or FREE_CREDIT_SUBSCRIPTION_GATE_USER_ID
    )


def benchmark_run_user_id_for_task(task_name: str) -> Optional[str]:
    """The dedicated identity a task must run as, or None to use the default benchmark user.

    Single source of truth for the run-user override so the mapping can be asserted directly
    instead of being buried in `run_single_task`. Getting it wrong is not a cosmetic bug: the
    sandbox payment-lifecycle tasks assert a Stripe hold. They run as the admin
    account with BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH so credits stay
    unlimited while minting still authorizes a hold. Production tasks stay on
    the dedicated non-admin live identity.
    """
    if task_name == FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME:
        return _free_credit_subscription_gate_user_id()
    if task_name == NEW_USER_PAYMENT_JOURNEY_TASK_NAME:
        return _new_user_payment_journey_user_id()
    if task_name in GATE_FIXTURE_TASK_USER_IDS:
        return GATE_FIXTURE_TASK_USER_IDS[task_name]
    if task_name in AGENT_PAYMENT_LIFECYCLE_TASK_NAMES:
        return os.environ.get(AGENT_PAYMENT_BENCHMARK_USER_ID_ENV, "").strip() or AGENT_PAYMENT_LIFECYCLE_USER_ID
    if task_name in AGENT_PAYMENT_PRODUCTION_LIFECYCLE_TASK_NAMES:
        return AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID
    return None


def _internal_api_headers(user_id: str) -> dict:
    """API-key headers for internal-only backend routes (never a user JWT)."""
    if not API_KEY:
        raise RuntimeError("BACKEND_API_KEY env var is required for internal backend routes.")
    return {"X-API-Key": API_KEY, "X-User-Id": user_id, "Content-Type": "application/json"}


async def _api_headers() -> dict:
    """Get auth headers — JWT for prod, API key fallback. Caches after first success."""
    global _cached_headers, _cached_headers_user_id, _auth_mode

    user_id = _current_benchmark_user_id()

    if _cached_headers and _cached_headers_user_id == user_id and _auth_mode in {"jwt", "api_key"}:
        return dict(_cached_headers)

    if user_id != USER_ID:
        if not API_KEY:
            raise RuntimeError("BACKEND_API_KEY env var is required for benchmark user overrides.")
        _auth_mode = "api_key"
        _cached_headers_user_id = user_id
        _cached_headers = {
            "X-API-Key": API_KEY,
            "X-User-Id": user_id,
            "Content-Type": "application/json",
        }
        return dict(_cached_headers)
    # If we already know API key is the only option, skip JWT attempts
    if _auth_mode == "api_key":
        _cached_headers_user_id = user_id
        _cached_headers = {
            "X-API-Key": API_KEY,
            "X-User-Id": user_id,
            "Content-Type": "application/json",
        }
        return dict(_cached_headers)

    try:
        auth = await authenticate()
        if auth.get("api_key") or auth.get("auth_mode") == "internal_api_key":
            api_key = auth.get("api_key") or API_KEY
            user_id = auth.get("user_id") or USER_ID
            if not api_key:
                raise RuntimeError("BACKEND_API_KEY env var is required for API key auth.")
            _cached_headers = {
                "X-API-Key": api_key,
                "X-User-Id": user_id,
                "Content-Type": "application/json",
            }
            _cached_headers_user_id = user_id
            _auth_mode = "api_key"
            return dict(_cached_headers)

        access_token = auth.get("access_token")
        if not access_token:
            raise RuntimeError("JWT auth returned no access token.")
        _cached_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        _cached_headers_user_id = user_id
        _auth_mode = "jwt"
        return dict(_cached_headers)
    except Exception:
        # Fallback to API key auth — cache this decision
        if not API_KEY:
            raise RuntimeError("BACKEND_API_KEY env var is required when JWT auth is unavailable.")
        _auth_mode = "api_key"
        _cached_headers_user_id = user_id
        _cached_headers = {
            "X-API-Key": API_KEY,
            "X-User-Id": user_id,
            "Content-Type": "application/json",
        }
        return dict(_cached_headers)


async def _preflight_message_person_bridge(base_url: str) -> None:
    """Fail before agent creation unless a current Mac polls this backend."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f"{base_url}/api/imessage/bridge/status", headers=headers)
    if response.status_code != 200:
        raise RuntimeError(f"iMessage bench preflight failed ({response.status_code}): {response.text[:200]}")
    payload = response.json()
    if payload.get("connected") is not True:
        last_seen_at = payload.get("last_seen_at") or "never"
        raise RuntimeError(
            "iMessage bench requires an updated, authenticated Mac app polling this exact backend; "
            f"last seen: {last_seen_at}"
        )


PRODUCTION_PAYMENT_IDENTITY_PROVISION_HINT = (
    "Provision it once with: cd back-end && STRIPE_SECRET_KEY=<production sk_live_ key> "
    "BENCHMARK_AGENTCARD_CARDHOLDER_ID=<production cardholder id> "
    "npx tsx scripts/setup-benchmark-payment.ts --live"
)


def _production_payment_identity_gap(usage: dict) -> Optional[str]:
    """Why the production payment identity cannot complete a purchase, or None when it can.

    `resolveAndIssuePurchaseCard` 402s a non-admin with no `Subscription.stripeCustomerId`, and an
    agent with no credit headroom stops at OUT_OF_CREDITS before it ever reaches checkout. Both are
    provisioning gaps, not product failures, so name them before the run spends live money.
    """
    tier = usage.get("tier")
    if tier is None or tier == "":
        return "it has no Subscription row, so no Stripe billing customer — every mint would 402"
    remaining = usage.get("remaining")
    if not isinstance(remaining, (int, float)) or isinstance(remaining, bool) or remaining <= 0:
        return f"it has no credit headroom (remaining={remaining!r}) — the agent stops at OUT_OF_CREDITS"
    return None


async def _preflight_production_payment_identity(base_url: str) -> None:
    """Fail fast when the production payment identity was never provisioned.

    Without this the deploy gate mints a LIVE AgentCard, then dies minutes later on an opaque 402.
    A non-200 is only a warning: a transient backend blip must not abort the gate on its own.
    """
    user_id = AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f"{base_url}/api/credits/usage", params={"userId": user_id}, headers=headers)
    if response.status_code != 200:
        print(
            f"    ⚠ Could not verify production payment identity {user_id} "
            f"({response.status_code}): {response.text[:200]}"
        )
        return
    gap = _production_payment_identity_gap(response.json())
    if gap is None:
        return
    raise RuntimeError(
        f"Production payment identity {user_id} is not provisioned: {gap}. {PRODUCTION_PAYMENT_IDENTITY_PROVISION_HINT}"
    )


async def _preflight_close_purchase_reuse_gate(base_url: str) -> None:
    """Close leftover HELD $1 lifecycle-probe cards so this run must request payment_approval.

    Only `agent-payment-production-purchase` sets disable_purchase_reuse. Other prod Stripe
    tasks keep the 24h cart-fingerprint reuse path.
    """
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            f"{base_url}/api/test-payment/lifecycle/close-held-reuse",
            headers=headers,
            json={"userId": AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID},
        )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Failed to close held purchase reuse for {AGENT_PAYMENT_LIFECYCLE_PROD_USER_ID}: "
            f"{resp.status_code} {resp.text[:300]}"
        )
    payload = resp.json() if resp.content else {}
    print(
        "    💳 Closed held purchase reuse for production purchase probe: "
        f"heldFound={payload.get('heldFound')} agentsCleaned={payload.get('agentsCleaned')} "
        f"orphanHeldIgnored={payload.get('orphanHeldIgnored')}"
    )


def _benchmark_agent_source_override() -> str:
    source = (os.environ.get("BENCHMARK_AGENT_SOURCE") or "MAC_APP").strip().upper()
    if source not in {"WEB", "MAC_APP", "SMS"}:
        raise ValueError(f"BENCHMARK_AGENT_SOURCE must be one of WEB, MAC_APP, or SMS; got {source!r}")
    return source


def _apply_local_agent_source_override(agent_id: str, source: str) -> None:
    _run_local_victoria_sql(
        'UPDATE "Agent" '
        f"SET source = {_sql_literal(source)} "
        f'WHERE id = {_sql_literal(agent_id)} AND "userId" = {_sql_literal(_current_benchmark_user_id())};'
    )


def _local_benchmark_task_queue(base_url: str) -> Optional[str]:
    """Local benchmark agents are scheduled onto the queue the harness preflights.

    Production ``--prod`` agents must stay on the shared production Temporal
    queue (generation-scoped workers). Cloudbench starts local workers too, but
    they do not reliably consume prod-API workflows on an isolated queue —
    routing ``--prod`` there leaves agents STARTING_UP until the liveness
    reconciler fails them (fleet 8bfe3691).
    """
    if not _is_local_base_url(base_url):
        return None
    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace:
        return None
    return f"navi-agent-tasks-{workspace}"


def _inject_benchmark_prompt_secrets(goal: str) -> str:
    """Substitute secret placeholders in benchmark prompts from the environment."""
    if "{GITHUB_DISPATCH_TOKEN}" in goal:
        token = os.environ.get("GITHUB_DISPATCH_TOKEN", "").strip()
        if not token:
            raise ValueError("GITHUB_DISPATCH_TOKEN is required for this benchmark prompt placeholder")
        goal = goal.replace("{GITHUB_DISPATCH_TOKEN}", token)
    return goal


def _doordash_food_plan_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for DoorDash food-plan fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = AMAN_FOOD_PLAN_USER_ID
    source_database_url = _prod_source_database_url_for_fixture(database_url)
    if source_database_url:
        env["BENCHMARK_DOORDASH_SOURCE_DATABASE_URL"] = source_database_url
    return env


def _run_doordash_food_plan_fixture(action: str) -> dict:
    if action == "apply" and action in _DOORDASH_FOOD_PLAN_FIXTURE_CACHE:
        return dict(_DOORDASH_FOOD_PLAN_FIXTURE_CACHE[action])
    result = subprocess.run(
        ["npx", "tsx", "scripts/doordash-food-plan-benchmark-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_doordash_food_plan_fixture_env(),
        capture_output=True,
        text=True,
        timeout=240 if action in ("apply", "freeze") else 60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"DoorDash food-plan benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}"
        )
    manifest = _parse_last_json_line(result.stdout)
    if action == "apply":
        _DOORDASH_FOOD_PLAN_FIXTURE_CACHE[action] = dict(manifest)
    elif action == "cleanup":
        _DOORDASH_FOOD_PLAN_FIXTURE_CACHE.clear()
    return manifest


def _doordash_food_plan_frozen_fixture() -> dict | None:
    """Resolve execute_prompt + checkout_manifest for agent override / judge context.

    Live ``apply`` caches a summary row (``benchmark_goal``, ``*_chars``) rather than the
    full checkout table. Prefer that goal for the agent prompt when present, but still load
    ``checkout_manifest`` from the frozen JSON so the judge keeps the authoritative table.
    """
    frozen_path = REPO_ROOT / ".context" / "benchmarks" / "doordash-food-plan-grocery-fixture.json"
    file_execute = ""
    file_checkout = ""
    if frozen_path.is_file():
        data = json.loads(frozen_path.read_text())
        raw_execute = data.get("execute_prompt")
        if isinstance(raw_execute, str) and raw_execute.strip():
            file_execute = raw_execute.strip()
        raw_checkout = data.get("checkout_manifest")
        if isinstance(raw_checkout, str) and raw_checkout.strip():
            file_checkout = raw_checkout.strip()

    manifest = _DOORDASH_FOOD_PLAN_FIXTURE_CACHE.get("apply")
    if manifest and manifest.get("benchmark_goal"):
        cached_checkout = manifest.get("checkout_manifest")
        checkout = (
            cached_checkout.strip() if isinstance(cached_checkout, str) and cached_checkout.strip() else file_checkout
        )
        return {
            "execute_prompt": str(manifest["benchmark_goal"]),
            "checkout_manifest": checkout,
        }
    if not file_execute:
        return None
    return {
        "execute_prompt": file_execute,
        "checkout_manifest": file_checkout,
    }


# Fixture execute_prompt is prod-derived and already assumes an authenticated
# session; still append this classifier so the agent does not fall into login/OTP.
DOORDASH_FOOD_PLAN_NO_LOGIN_CLASSIFIER = "do NOT try to login."


def _doordash_food_plan_prompt_override(task: BenchmarkTask) -> str | None:
    if task.name != DOORDASH_FOOD_PLAN_TASK_NAME:
        return None
    frozen = _doordash_food_plan_frozen_fixture()
    if not frozen:
        return None
    prompt = frozen["execute_prompt"]
    if DOORDASH_FOOD_PLAN_NO_LOGIN_CLASSIFIER.lower() not in prompt.lower():
        prompt = f"{prompt.rstrip()}\n\n{DOORDASH_FOOD_PLAN_NO_LOGIN_CLASSIFIER}"
    return prompt


def _doordash_food_plan_task_requirement_for_judge(task: BenchmarkTask) -> str:
    override = _doordash_food_plan_prompt_override(task)
    return override if override else task.prompt


def _doordash_food_plan_manifest_context_for_judge(task: BenchmarkTask) -> str:
    if task.name != DOORDASH_FOOD_PLAN_TASK_NAME:
        return ""
    frozen = _doordash_food_plan_frozen_fixture()
    if not frozen:
        return ""
    sections: list[str] = []
    if frozen.get("checkout_manifest"):
        sections.append(
            "Authoritative checkout manifest table (prod-derived; every Safeway and conditional "
            "99 Ranch line must be satisfied or manifest-allowed omitted/substituted):\n" + frozen["checkout_manifest"]
        )
    sections.append(
        "Authoritative execute manifest text (same source the agent received):\n" + frozen["execute_prompt"]
    )
    return "\n\n".join(sections)


def _doordash_food_plan_supplemental_cart_evidence(data: dict) -> str:
    """Collect full cart itemization from write-lock and browser evaluate dumps.

    DoorDash write-lock approvals often summarize only the first handful of SKUs while
    reporting a larger cart count. For manifest-exact judging, surface every grounded
    cart dump the trajectory captured.
    """
    snippets: list[str] = []
    benchmark_state = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    for req in benchmark_state.get("attention_requests_seen") or []:
        if not isinstance(req, dict):
            continue
        question = str(req.get("question") or req.get("message") or "").strip()
        if len(question) < 80:
            continue
        kind = req.get("kind") or "attention"
        snippets.append(f"Attention request ({kind}):\n{question[:20000]}")

    for message in data.get("messages") or []:
        if not isinstance(message, dict):
            continue
        text = str(message.get("message") or message.get("text") or "").strip()
        if not text:
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        tool_name = metadata.get("toolName")
        action_type = metadata.get("action_type")
        if tool_name == "request_user_approval":
            snippets.append(f"Approval tool message:\n{text[:20000]}")
            continue
        if action_type != "evaluate":
            continue
        lowered = text.lower()
        if "result:" not in text:
            continue
        if "×" in text or "in cart" in lowered or "ground beef" in lowered or "safeway" in lowered:
            snippets.append(f"Browser cart evaluate dump:\n{text[:20000]}")

    if not snippets:
        return ""
    return "\n\n---\n\n".join(snippets)


def _benchmark_goal_for_task(task: BenchmarkTask, base_url: str) -> str:
    """Resolve the root-agent goal sent to POST /api/agents for a benchmark task."""
    from utils.payment_boundary_goal import payment_boundary_operational_suffix

    goal = (
        os.environ.get("BENCHMARK_GOAL_OVERRIDE")
        or _doordash_food_plan_prompt_override(task)
        or _prod_user_data_prompt_override(task)
        or task.prompt
    )
    goal = goal.replace("{frontend_url}", _frontend_url_for_benchmark(base_url))
    goal = auth_test_site.resolve_goal(goal, auth_test_site.active_manifest())
    goal = resolve_callee_prompt(goal, getattr(task, "_callee_phone_number", ""), task.name)
    goal = _inject_benchmark_prompt_secrets(goal)
    if task.success_on_payment_card_request and PAYMENT_BOUNDARY_GOAL_MARKER not in goal:
        goal += payment_boundary_operational_suffix()
    return goal


def _prod_user_data_prompt_override(task: BenchmarkTask) -> str | None:
    if task.name != USER_DATA_PROD_GREP_TASK_NAME:
        return None
    explicit = os.environ.get("BENCHMARK_USER_DATA_PROD_PROMPT", "").strip()
    if explicit:
        return explicit
    prompt_path = REPO_ROOT / ".context" / "benchmarks" / "user-data-prod-prompts.json"
    if not prompt_path.exists():
        return None
    data = json.loads(prompt_path.read_text())
    questions = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(questions, list) or not questions:
        raise ValueError(f"{prompt_path} must contain a non-empty questions array")
    rendered = "\n".join(f"{idx + 1}. {str(question)}" for idx, question in enumerate(questions))
    return (
        task.prompt
        + "\n\nPrivate prod verification questions from .context/benchmarks/user-data-prod-prompts.json:\n"
        + rendered
    )


def _wmh_initial_state_evidence(task: BenchmarkTask) -> dict | None:
    if task.wmh_initial_state is None:
        return None
    canonical = json.dumps(task.wmh_initial_state, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {
        "sha256": hashlib.sha256(canonical.encode()).hexdigest(),
        "provenance": getattr(task, "_wmh_initial_state_source", f"tasks.json:{task.name}"),
        "session_id": getattr(task, "_wmh_seeded_session_id", None),
    }


# One native retirement attempt joins every cancelled prediction within a bound.
# After a timeout with a wide fan-out in flight, that drain can outlast it and
# the attempt answers 500 while the session stays fenced (run 7, 2026-10-20).
# The server accepts a fresh retirement, so server/transport failures are retried.
_NATIVE_RETIREMENT_ATTEMPTS = 4
_NATIVE_RETIREMENT_BACKOFF_SECONDS = (2.0, 5.0, 10.0)
_NATIVE_RETIREMENT_SLEEP = asyncio.sleep


async def _end_owned_native_session(owned: dict) -> dict:
    for attempt in range(_NATIVE_RETIREMENT_ATTEMPTS):
        try:
            return await WMHHttpClient(owned["base_url"]).end_session(owned["model_name"], owned["session_id"])
        except (httpx.HTTPStatusError, httpx.TransportError) as exc:
            retryable = isinstance(exc, httpx.TransportError) or exc.response.status_code >= 500
            if not retryable or attempt + 1 == _NATIVE_RETIREMENT_ATTEMPTS:
                raise
            delay = _NATIVE_RETIREMENT_BACKOFF_SECONDS[min(attempt, len(_NATIVE_RETIREMENT_BACKOFF_SECONDS) - 1)]
            print(
                f"    ⚠ Native WMH retirement attempt {attempt + 1}/{_NATIVE_RETIREMENT_ATTEMPTS} "
                f"for session {owned['session_id'][:12]} failed ({type(exc).__name__}); retrying in {delay:g}s"
            )
            await _NATIVE_RETIREMENT_SLEEP(delay)
    raise AssertionError("unreachable native retirement attempt bound")


async def _retire_owned_native_world(task: BenchmarkTask, agent_id: str | None = None) -> dict | None:
    """Join this execution's admitted predictions before freezing its outcome.

    Benchmark-owned seed -> exact native session retirement -> provider join
                         -> final state/usage receipt -> evaluation/archive
    Explicitly supplied sessions belong to the caller and are never retired here.
    """
    owned = getattr(task, "_wmh_owned_session", None)
    if not owned or owned["engine"] != "experiential":
        return None
    if agent_id and agent_id != owned["root_agent_id"]:
        error = RuntimeError("Native world retirement root does not match this benchmark execution")
        task._wmh_retirement_error = _native_world_retirement_error_details(owned, error)
        raise error
    receipt = getattr(task, "_wmh_retirement_receipt", None)
    if receipt is not None:
        return receipt
    operation = getattr(task, "_wmh_retirement_operation", None)
    if operation is None:

        async def retire():
            receipt = await _end_owned_native_session(owned)
            if (
                receipt.get("engine") != "experiential"
                or receipt.get("join_verified") is not True
                or receipt.get("ended") != owned["session_id"]
                or receipt.get("session_id") != owned["session_id"]
                or receipt.get("session_scope_id") != owned["root_agent_id"]
                or type(receipt.get("revision")) is not int
                or receipt["revision"] < 0
                or not isinstance(receipt.get("state"), dict)
                or not isinstance(receipt.get("history"), list)
                or not isinstance(receipt.get("usage"), dict)
            ):
                raise RuntimeError("Native world retirement did not prove the exact owned provider join")
            task._wmh_retirement_receipt = receipt
            return receipt

        operation = asyncio.create_task(retire())
        task._wmh_retirement_operation = operation
    try:
        return await asyncio.shield(operation)
    except Exception as exc:
        task._wmh_retirement_error = _native_world_retirement_error_details(owned, exc)
        raise


def _native_world_retirement_error_details(owned: dict, error: Exception) -> dict:
    return {
        "type": type(error).__name__,
        "message": str(error),
        "session_id": owned.get("session_id"),
        "session_scope_id": owned.get("root_agent_id"),
        "join_verified": False,
        "cost_verified": False,
    }


def _native_world_retirement_diagnostics(task: BenchmarkTask, logs: dict | None, error=None) -> dict:
    """Keep actual retirement evidence even when independent log collection fails."""
    logs = logs if isinstance(logs, dict) else {}
    if getattr(task, "_wmh_retirement_receipt", None) is not None:
        logs["wmh_retirement"] = task._wmh_retirement_receipt
    if getattr(task, "_wmh_retirement_error", None) is not None:
        logs["wmh_retirement_error"] = task._wmh_retirement_error
        logs["benchmark_cost_placeholder"] = {"cost_cents": 0, "settled": False}
    if error is not None and getattr(task, "_wmh_owned_session", None):
        logs["benchmark_execution_error"] = {"type": type(error).__name__, "message": str(error)}
    if getattr(task, "_wmh_agent_admission", None) is not None:
        logs["wmh_agent_admission"] = task._wmh_agent_admission
    return logs


def _native_world_retirement_failure_reason(task: BenchmarkTask) -> str:
    error = getattr(task, "_wmh_retirement_error", None)
    if not error:
        return ""
    return f" | Native WMH retirement failed: {error['type']}: {error['message']} (join and cost unverified)"


def _recover_owned_native_admission_root(task: BenchmarkTask, agent_id: str) -> str:
    """Recover only the UUID this execution seeded before its backend POST."""
    owned = getattr(task, "_wmh_owned_session", None)
    if agent_id or not owned or owned["engine"] != "experiential":
        return agent_id
    root = owned["root_agent_id"]
    if getattr(task, "_wmh_agent_admission", None) is None:
        task._wmh_agent_admission = {"root_agent_id": root, "creation_confirmed": False}
    return root


async def _delete_owned_native_admission_root(base_url: str, task: BenchmarkTask, agent_id: str) -> bool:
    """A missing create response does not prove creation or verified deletion."""
    admission = getattr(task, "_wmh_agent_admission", None)
    if admission and admission["root_agent_id"] != agent_id:
        raise RuntimeError("Native admission cleanup root does not match this benchmark execution")
    try:
        await delete_agent(base_url, agent_id)
    except Exception as exc:
        if not admission:
            raise
        admission["cleanup_observation"] = "unverified"
        admission["cleanup_error"] = {"type": type(exc).__name__, "message": str(exc)}
        try:
            await get_agent(base_url, agent_id)
        except AgentNotFoundError:
            admission["cleanup_observation"] = "not_found"
            return False
        except Exception as observed:
            admission["observation_error"] = {"type": type(observed).__name__, "message": str(observed)}
        raise
    if admission:
        admission["cleanup_observation"] = "deleted"
    return True


async def create_agent(
    base_url: str,
    task: BenchmarkTask,
) -> str:
    """Create a benchmark agent. Returns agent_id."""
    # Flag the created root agent as a benchmark run so admin-health metrics strip it
    # out. Benchmarks run under a real operator account (e.g. Andy) via JWT or API key;
    # echoing the internal backend key here proves the marker came from a benchmark
    # (external clients never have it) independent of the create's auth mode. See
    # back-end agents/routes.ts and admin-health/repo.ts.
    headers = {**(await _api_headers())}
    if API_KEY:
        headers["X-Benchmark-Run"] = API_KEY
    goal = _benchmark_goal_for_task(task, base_url)
    source_override = _benchmark_agent_source_override()
    request_source = source_override if source_override in {"WEB", "MAC_APP"} else "WEB"

    body: dict = {
        "goal": goal,
        "source": request_source,
        "price_limit_cents": task.effective_price_limit_cents(),
        "verifier": {
            "type": "FLOAT_LLM_JUDGE",
        },
    }
    local_task_queue = _local_benchmark_task_queue(base_url)
    if local_task_queue:
        body["task_queue"] = local_task_queue

    write_lock_enabled = _resolve_write_lock_enabled(task)
    if write_lock_enabled is not None:
        body["write_lock_enabled"] = write_lock_enabled

    if task.name == "kill-agent-subtree":
        body["pause_state"] = True  # The owned target fixture is prepared before root reasoning.

    # A task-level declaration wins because live side-effect benchmarks must not
    # replay cached decisions. Tasks without a declaration retain the env A/B toggle.
    fast_mode_cache = _resolved_fast_mode_cache(task)
    if fast_mode_cache is not None:
        body["fast_mode_cache_enabled"] = fast_mode_cache

    world_model_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real").strip().lower()
    if world_model_mode in {"simulate", "shadow"}:
        body["world_model_mode"] = world_model_mode

    # The root's first simulated boundary is often the deferred startup SMS.
    # Establish the benchmark world before creating the agent so that boundary
    # cannot win the session-creation race with its generic runtime seed.
    expected_agent_id: str | None = None
    if task.wmh_initial_state is not None:
        if world_model_mode != "simulate":
            raise ValueError(f"{task.name}: wmh_initial_state requires simulate mode")
        if os.environ.get("WMH_SESSION_ID") or os.environ.get("WORLD_MODEL_SESSION_ID"):
            raise ValueError(f"{task.name}: explicit WMH session id would bypass wmh_initial_state")
        base = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
        model_name = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
        if not base or not model_name:
            raise ValueError(f"{task.name}: WMH_BASE_URL and WMH_MODEL_NAME are required to seed the world")
        validate_wmh_initial_state(task.wmh_initial_state, task.name)
        expected_agent_id = str(uuid.uuid4())
        seed_state = {
            "structured": {
                **task.wmh_initial_state["structured"],
                "root_agent_id": expected_agent_id,
                "root_goal": goal,
            },
            "scratchpad": task.wmh_initial_state["scratchpad"],
        }
        session_id = await WMHHttpClient(base).create_session(
            model_name,
            task=goal,
            seed_state=seed_state,
            session_scope_id=expected_agent_id,
        )
        body["agent_id"] = expected_agent_id
        task._wmh_seeded_session_id = session_id
        task._wmh_owned_session = {
            "base_url": base,
            "model_name": model_name,
            "session_id": session_id,
            "root_agent_id": expected_agent_id,
            "engine": os.environ.get("WMH_ENGINE", "legacy"),
        }
        print(f"    🌍 WHM initial state seeded before agent start: {session_id[:12]}...")

    # A task may narrow the user context its agent sees. Used when a real user's
    # connected data offers a route the scenario is not testing — the gate removes
    # that shortcut without touching the prompt or the pass criteria.
    if task.context_gates:
        body["context_gates"] = task.context_gates

    # A task may pin its root agent to a specific Rose pool. Used when the
    # default pool's primary declines the task's prompt outright, which is a
    # model-policy outcome no retry can change.
    model_override = (os.environ.get("BENCHMARK_MODEL") or "").strip()
    # Fast Mode trees (mass-agent) were recorded against Ultra. Retargeting
    # them to a speed pool invalidates the July cache (missing title / tools).
    if model_override and task.demo_cache != "on":
        body["model"] = model_override
    elif task.model:
        body["model"] = task.model

    if task.start_phase:
        body["start_phase"] = task.start_phase
    # Planner memory is an explicit per-run A/B flag: default off for every benchmark.
    body["memory_enabled"] = task.memory == "on"
    if task.response_schema:
        body["response_schema"] = task.response_schema

    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(f"{base_url}/api/agents", headers=headers, json=body)
        if resp.status_code not in (200, 201):
            raise Exception(f"Failed to create agent: {resp.status_code} - {resp.text}")
        data = resp.json()
        agent_id = data["agent_id"]
        if expected_agent_id is not None and agent_id != expected_agent_id:
            raise RuntimeError(f"{task.name}: backend returned agent_id {agent_id}, expected {expected_agent_id}")
        if expected_agent_id is not None:
            task._wmh_agent_admission = {"root_agent_id": agent_id, "creation_confirmed": True}
        if source_override == "SMS":
            if not _is_local_base_url(base_url):
                raise RuntimeError(
                    "BENCHMARK_AGENT_SOURCE=SMS is local-only because the public create-agent API "
                    "does not accept SMS as a client-supplied source."
                )
            _apply_local_agent_source_override(agent_id, source_override)
            print(f"     source_override={source_override} (applied via local DB)")
        if local_task_queue:
            print(f"     task_queue={local_task_queue} (local benchmark override)")
        if write_lock_enabled is not None:
            patch_resp = await client.patch(
                f"{base_url}/api/agents/{agent_id}",
                headers=headers,
                json={"write_lock_enabled": write_lock_enabled},
            )
            if patch_resp.status_code != 200:
                raise Exception(
                    f"Failed to verify write_lock_enabled override: {patch_resp.status_code} - {patch_resp.text}"
                )
            patched = patch_resp.json().get("agent", {})
            if patched.get("write_lock_enabled") != write_lock_enabled:
                raise Exception(
                    "write_lock_enabled override did not persist: "
                    f"expected {write_lock_enabled}, got {patched.get('write_lock_enabled')}"
                )
    return agent_id


async def archive_agent_start(base_url: str, agent_id: str) -> Optional[str]:
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{base_url}/api/archive/agent-start", headers=headers, json={"agentId": agent_id})
        if resp.status_code != 200:
            print(f"    ⚠ Trace archive start failed: {resp.status_code} {resp.text[:160]}")
            return None
        fixture = resp.json().get("fixture")
        return fixture.get("ref") if isinstance(fixture, dict) else None
    except Exception as exc:
        print(f"    ⚠ Trace archive start failed: {exc}")
        return None


async def archive_agent_finalize(
    base_url: str,
    agent_id: str,
    task_name: str,
    *,
    force: bool = False,
    benchmark_passed: Optional[bool] = None,
    benchmark_status: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> Optional[str]:
    if not agent_id:
        return None
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient(timeout=90) as client:
            body = {
                "rootAgentId": agent_id,
                "benchmarkTaskName": task_name,
                "force": force,
                "worldModelMode": os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
            }
            if benchmark_passed is not None:
                body["benchmarkPassed"] = benchmark_passed
            if benchmark_status is not None:
                body["benchmarkStatus"] = benchmark_status
            if failure_reason:
                body["failureReason"] = failure_reason[:1000]
            resp = await client.post(
                f"{base_url}/api/archive/agent-finalize",
                headers=headers,
                json=body,
            )
        if resp.status_code != 200:
            print(f"    ⚠ Trace archive finalize failed: {resp.status_code} {resp.text[:160]}")
            return None
        manifest = resp.json().get("manifest")
        return manifest.get("ref") if isinstance(manifest, dict) else None
    except Exception as exc:
        print(f"    ⚠ Trace archive finalize failed: {exc}")
        return None


async def evaluate_world_model_fidelity(agent_id: str) -> dict:
    """Best-effort WMH replay scoring for a finalized trace archive."""
    if not agent_id:
        return {"status": "disabled", "reason": "agent_id is missing"}
    try:
        return await evaluate_archive_with_world_model(agent_id)
    except Exception as exc:
        return {"status": "error", "reason": str(exc)[:300]}


async def finalize_archive_and_score_world_model(
    base_url: str,
    agent_id: str,
    task_name: str,
    *,
    force: bool = False,
    owned_batch_final: bool = False,
    benchmark_passed: Optional[bool] = None,
    benchmark_status: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> tuple[Optional[str], dict]:
    """Finalize durable trace storage and score WMH prediction fidelity for the run."""

    if cloud_batch_cleanup.contract() is not None and not owned_batch_final:
        return None, {"status": "deferred", "reason": "owned cloud batch cleanup precedes archive"}
    archive_manifest_ref = await archive_agent_finalize(
        base_url,
        agent_id,
        task_name,
        force=force,
        benchmark_passed=benchmark_passed,
        benchmark_status=benchmark_status,
        failure_reason=failure_reason,
    )
    if archive_manifest_ref:
        print(f"    🧊 Trace archive manifest: {archive_manifest_ref}")
    world_model_fidelity = await evaluate_world_model_fidelity(agent_id)
    if world_model_fidelity.get("status") == "scored":
        print(
            "    🧠 WMH prediction accuracy: "
            f"{world_model_fidelity.get('mean_score', 0):.3f} "
            f"n={world_model_fidelity.get('n_steps', 0)}"
        )
    return archive_manifest_ref, world_model_fidelity


async def get_agent(base_url: str, agent_id: str) -> dict:
    """GET /api/agents/:id. Raises AgentNotFoundError on 404."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
        if resp.status_code == 404:
            raise AgentNotFoundError(f"Agent {agent_id[:12]} not found (404)")
        if resp.status_code != 200:
            raise Exception(f"Failed to get agent: {resp.status_code}")
        return resp.json()


async def delete_agent(base_url: str, agent_id: str) -> None:
    """DELETE /api/agents/:id"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(f"{base_url}/api/agents/{agent_id}", headers=headers)
        if response.status_code != 204:
            raise RuntimeError(f"Failed to delete agent {agent_id}: HTTP {response.status_code}")


async def get_tool_usage(base_url: str, agent_id: str) -> dict:
    """GET /api/tool-usage/tree/:id — aggregated cache metrics for entire agent tree."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/tool-usage/tree/{agent_id}", headers=headers)
        if resp.status_code == 200:
            return resp.json()
        return {}


async def _get_settled_tool_usage(
    base_url: str,
    agent_id: str,
    *,
    minimum_cost_cents: float = 0.0,
    max_attempts: int = 10,
    retry_delay_seconds: float = 2,
    fetch_usage: Callable[[str, str], Awaitable[dict]] = get_tool_usage,
) -> dict:
    """Snapshot tree tool usage only after late ToolUsage writes have settled.

    Terminal agent status is broadcast before every agent in the tree has persisted its
    ToolUsage row: on agent 8a5ff1db the cost-limit flip landed 12.0s ahead of the browser
    explore_agent's 430.44c row, so the single-read snapshot recorded 5c / llm_call_count=1
    instead of the real 435.86c subtree cost. Poll — bounded, like
    ``_get_initial_payment_lifecycle_with_retry`` — until the LLM call count stops growing
    and covers every agent in the tree (each agent makes at least one LLM call, and
    ``agent_count`` is derived from the busId tree rather than from the usage rows, so it is
    an independent completeness signal). A cost-limited root can still have enough
    early zero-cost calls to pass that count; require the terminal agent's known cost
    floor as well, and wait for both call count and cost to stabilize.
    """
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    best: Optional[dict] = None
    best_calls = -1
    best_cost = -1.0
    previous_calls: Optional[int] = None
    previous_cost: Optional[float] = None
    last_error: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            await asyncio.sleep(retry_delay_seconds)
        try:
            usage = await fetch_usage(base_url, agent_id)
        except Exception as error:
            last_error = error
            print(f"    ⚠ Transient tree tool-usage read failed ({attempt}/{max_attempts}): {error}")
            continue
        calls = _as_nonnegative_int(usage.get("llm_call_count"))
        try:
            cost = max(0.0, float(usage.get("total_cost_cents") or 0))
        except (TypeError, ValueError):
            cost = 0.0
        if calls > best_calls or (calls == best_calls and cost > best_cost):
            best, best_calls, best_cost = usage, calls, cost
        tree_covered = best_calls >= max(_as_nonnegative_int(usage.get("agent_count")), 1)
        if previous_calls == calls and previous_cost == cost and tree_covered and cost >= minimum_cost_cents:
            return best if best is not None else usage
        previous_calls = calls
        previous_cost = cost
    if best is None:
        raise RuntimeError(f"Tree tool usage remained unavailable after {max_attempts} reads: {last_error}")
    print(
        f"    ⚠ Tree tool usage never settled after {max_attempts} reads "
        f"(llm_call_count={best_calls}, agent_count={_as_nonnegative_int(best.get('agent_count'))}, "
        f"cost_cents={best_cost}, minimum_cost_cents={minimum_cost_cents})"
    )
    return best


async def get_agent_tool_usage(base_url: str, agent_id: str) -> dict:
    """GET raw per-agent usage items for provider/model attribution."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/tool-usage/{agent_id}", headers=headers)
        if resp.status_code == 200:
            return resp.json()
        raise RuntimeError(
            f"Incomplete benchmark usage telemetry for agent {agent_id[:12]}: "
            f"GET /api/tool-usage returned {resp.status_code}"
        )


async def get_llm_usage_details(base_url: str, root_agent_id: str, tree_stats: dict) -> tuple[dict, dict]:
    """Aggregate provider attribution and prompt-cache share for an agent tree."""
    agent_ids = {
        str(agent.get("agent_id") or agent.get("id") or "")
        for agent in tree_stats.get("all_agents", [])
        if isinstance(agent, dict)
    }
    agent_ids.discard("")
    agent_ids.add(root_agent_id)
    payloads = await asyncio.gather(*(get_agent_tool_usage(base_url, agent_id) for agent_id in sorted(agent_ids)))
    items: list[dict] = []
    for agent_id, payload in zip(sorted(agent_ids), payloads):
        for usage in payload.get("usages", []):
            usage_items = usage.get("usage_items") if isinstance(usage, dict) else None
            if isinstance(usage_items, list):
                items.extend(
                    {**item, "_benchmark_agent_id": agent_id} for item in usage_items if isinstance(item, dict)
                )
    return aggregate_usage_items(items), aggregate_prompt_cache_share(items)


async def get_test_payment_lifecycle(base_url: str, agent_id: str) -> dict:
    """Read the sanitized cross-provider lifecycle snapshot for a benchmark agent."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{base_url}/api/test-payment/lifecycle",
            headers=headers,
            params={"agentId": agent_id},
        )
        if resp.status_code != 200:
            raise Exception(f"Failed to get payment lifecycle: {resp.status_code} {resp.text[:300]}")
        return resp.json()


async def _get_initial_payment_lifecycle_with_retry(
    base_url: str,
    agent_id: str,
    *,
    max_attempts: int = 43,
    retry_delay_seconds: float = 10,
    fetch_lifecycle: Callable[[str, str], Awaitable[dict]] = get_test_payment_lifecycle,
) -> dict:
    """Observe the first lifecycle snapshot across the provider's consistency window."""
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    last_error: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await fetch_lifecycle(base_url, agent_id)
        except Exception as error:
            last_error = error
            if attempt >= max_attempts:
                break
            print(
                f"    ⚠ Transient initial payment lifecycle read failed ({attempt}/{max_attempts}); retrying: {error}"
            )
            await asyncio.sleep(retry_delay_seconds)
    raise RuntimeError(
        f"Initial payment lifecycle remained unavailable after {max_attempts} reads: {last_error}"
    ) from last_error


def _payment_lifecycle_settlement_state(lifecycle: object) -> str:
    """Describe the provider money rows a timed-out lifecycle was still waiting on.

    The first mismatch is usually Rose's purchase status, which reads the same whether Rose's
    reconciler stalled or AgentCard never released the closed card's hold. Only THIS card's
    org transfer row tells those apart.
    """
    if not isinstance(lifecycle, dict):
        return ""
    parts = []
    purchase = lifecycle.get("purchase")
    if isinstance(purchase, dict):
        parts.append(f"purchase.status={purchase.get('status')!r}")
    wallet_funding = lifecycle.get("walletFunding")
    if isinstance(wallet_funding, dict):
        parts.append(f"walletFunding.status={wallet_funding.get('status')!r}")
    agent_card = lifecycle.get("agentCard")
    if isinstance(agent_card, dict):
        fields = ("status", "balanceCents")
        parts.append(f"agentCard={json.dumps({key: agent_card.get(key) for key in fields})}")
    org_transfer = lifecycle.get("orgTransfer")
    if isinstance(org_transfer, dict):
        fields = ("id", "cardId", "status", "transferredCents", "releasedCents")
        parts.append(f"orgTransfer={json.dumps({key: org_transfer.get(key) for key in fields})}")
    return f"; last observed {', '.join(parts)}" if parts else ""


class _PaymentReconciliationDeadline(TimeoutError):
    """The benchmark-owned reconciliation budget expired, rather than a failed lifecycle read."""


def _payment_reconciliation_timeout(
    error: str, lifecycle: object, *, task_name: str | None = None, allow_release_skip: bool = True
) -> RuntimeError:
    """Classify the approved sandbox/live release stall; keep the existing deadline owner."""
    message = (
        "Payment lifecycle did not reach the expected terminal state before timeout: "
        f"{error}{_payment_lifecycle_settlement_state(lifecycle)}"
    )
    if (
        allow_release_skip
        and _agentcard_release_skip_enabled()
        and _agentcard_release_skip_lifecycle(task_name, lifecycle)
    ):
        return AgentCardReleaseStall(message, lifecycle=lifecycle)
    return RuntimeError(message)


async def _wait_for_expected_payment_lifecycle(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    initial_lifecycle: dict,
    *,
    timeout_seconds: float = 420,
    poll_interval_seconds: float = 10,
    fetch_lifecycle: Callable[[str, str], Awaitable[dict]] = get_test_payment_lifecycle,
    recover_lifecycle: Optional[Callable[[str, str], Awaitable[dict]]] = None,
    resume_pending_after_seconds: Optional[float] = None,
) -> dict:
    """Observe durable recovery while AgentCard asynchronously releases a closed-card hold."""
    lifecycle = initial_lifecycle
    started_at = time.monotonic()
    deadline = started_at + timeout_seconds
    next_resume_at = started_at + (resume_pending_after_seconds or 0)
    retryable_statuses = {"FUNDING_RECLAIM_FAILED", "REFUND_FAILED"}
    consecutive_fetch_errors = 0
    last_fetch_error: Optional[Exception] = None
    while True:
        error = _validate_payment_lifecycle(
            task,
            {"_benchmark": {"payment_lifecycle": lifecycle}},
        )
        if error is None:
            return lifecycle
        purchase = lifecycle.get("purchase") if isinstance(lifecycle, dict) else None
        status = purchase.get("status") if isinstance(purchase, dict) else None
        wallet_funding = lifecycle.get("walletFunding") if isinstance(lifecycle, dict) else None
        # Reconciliation commits the durable funding reclaim before it refunds Stripe and marks
        # the purchase VOIDED. A lifecycle read can therefore observe HELD + RECLAIMED in that
        # short persistence window. Keep polling both in-flight states instead of treating the
        # internally consistent recovery race as a terminal benchmark mismatch.
        compensation_pending = (
            status == "HELD"
            and isinstance(wallet_funding, dict)
            and wallet_funding.get("status") in {"RECLAIMING", "RECLAIMED"}
        )
        # When the task expects a purchase but abandon returned an empty lifecycle (e.g. mint
        # reused another agent's HELD row), keep polling until timeout instead of treating the
        # empty snapshot as a successful terminal state.
        expected_lifecycle = task.expected_payment_lifecycle or {}
        expected_purchase = expected_lifecycle.get("purchase")
        missing_expected_purchase = isinstance(expected_purchase, dict) and not isinstance(purchase, dict)
        if status not in retryable_statuses and not compensation_pending and not missing_expected_purchase:
            return lifecycle
        if time.monotonic() >= deadline:
            if last_fetch_error is not None:
                raise RuntimeError(
                    "Payment lifecycle remained unavailable at the reconciliation deadline after "
                    f"{consecutive_fetch_errors} consecutive reads: {last_fetch_error}"
                    f"{_payment_lifecycle_settlement_state(lifecycle)}"
                ) from last_fetch_error
            raise _payment_reconciliation_timeout(error, lifecycle, task_name=task.name)
        if recover_lifecycle is None:
            await asyncio.sleep(poll_interval_seconds)
        owned_timeout = None
        try:
            if recover_lifecycle is None:
                lifecycle = await fetch_lifecycle(base_url, agent_id)
            else:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _PaymentReconciliationDeadline("Payment reconciliation deadline reached before recovery")
                # An owned recovery may take longer than a read. Keep its sleep,
                # observation and idempotent POST inside the original deadline.
                async with asyncio.timeout(remaining) as owned_timeout:
                    await asyncio.sleep(poll_interval_seconds)
                    if resume_pending_after_seconds is None:
                        candidate = await recover_lifecycle(base_url, agent_id)
                    else:
                        candidate = await fetch_lifecycle(base_url, agent_id)
                        now = time.monotonic()
                        if now >= deadline:
                            raise _PaymentReconciliationDeadline(
                                "Payment reconciliation deadline reached after observation"
                            )
                        candidate_error = _validate_payment_lifecycle(
                            task, {"_benchmark": {"payment_lifecycle": candidate}}
                        )
                        candidate_purchase = candidate.get("purchase") if isinstance(candidate, dict) else None
                        candidate_funding = candidate.get("walletFunding") if isinstance(candidate, dict) else None
                        candidate_status = (
                            candidate_purchase.get("status") if isinstance(candidate_purchase, dict) else None
                        )
                        resumable = candidate_status in retryable_statuses or (
                            candidate_status == "HELD"
                            and isinstance(candidate_funding, dict)
                            and candidate_funding.get("status") in {"RECLAIMING", "RECLAIMED"}
                        )
                        if candidate_error is not None and resumable and now >= next_resume_at:
                            if time.monotonic() >= deadline:
                                raise _PaymentReconciliationDeadline(
                                    "Payment reconciliation deadline reached before resuming cleanup"
                                )
                            # The backend still applies its stale-lease CAS and
                            # purchase fencing. This resumes the same allocation.
                            next_resume_at = now + resume_pending_after_seconds
                            candidate = await recover_lifecycle(base_url, agent_id)
                if time.monotonic() >= deadline:
                    raise _PaymentReconciliationDeadline("Payment reconciliation response arrived after its deadline")
                lifecycle = candidate
            consecutive_fetch_errors = 0
            last_fetch_error = None
        except Exception as fetch_error:
            if isinstance(fetch_error, _PaymentReconciliationDeadline) or (
                owned_timeout is not None and owned_timeout.expired()
            ):
                raise _payment_reconciliation_timeout(
                    error, lifecycle, task_name=task.name, allow_release_skip=last_fetch_error is None
                ) from fetch_error
            # Lifecycle reads join local DB state with several read-only provider
            # views. A single transient provider timeout must not turn a
            # successfully compensated purchase into a benchmark failure. Keep
            # the last durable snapshot and retry within the existing bounded
            # reconciliation window. AgentCard throttling can outlast three
            # ten-second reads, so the reconciliation deadline is the one
            # authoritative bound instead of a second, shorter outage cutoff.
            consecutive_fetch_errors += 1
            last_fetch_error = fetch_error
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "Payment lifecycle remained unavailable at the reconciliation deadline after "
                    f"{consecutive_fetch_errors} consecutive reads: {fetch_error}"
                    f"{_payment_lifecycle_settlement_state(lifecycle)}"
                ) from fetch_error
            print(
                "    ⚠ Transient payment lifecycle read failed "
                f"({consecutive_fetch_errors} consecutive); retrying until reconciliation deadline: {fetch_error}"
            )


PAYMENT_CLEANUP_TIMEOUT_SECONDS = 180
# Matches the existing stale RECLAIMING lease in purchaseCleanup.ts. This is
# retry eligibility within the unchanged 420-second reconciliation window.
PAYMENT_RECLAIM_RETRY_AFTER_SECONDS = 120


async def abandon_test_payment(base_url: str, agent_id: str) -> dict:
    """Close/reclaim/refund a benchmark card after issuance but before merchant submission."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=PAYMENT_CLEANUP_TIMEOUT_SECONDS) as client:
        resp = await client.post(
            f"{base_url}/api/test-payment/lifecycle/abandon",
            headers=headers,
            json={"agentId": agent_id},
        )
        if resp.status_code != 200:
            raise Exception(f"Failed to abandon test payment: {resp.status_code} {resp.text[:300]}")
        return resp.json()


def _payment_abandonment_has_started(lifecycle: dict) -> bool:
    """Recognize durable evidence that an indeterminate abandon POST reached the backend."""
    purchase = lifecycle.get("purchase") if isinstance(lifecycle, dict) else None
    funding = lifecycle.get("walletFunding") if isinstance(lifecycle, dict) else None
    purchase_status = purchase.get("status") if isinstance(purchase, dict) else None
    funding_status = funding.get("status") if isinstance(funding, dict) else None
    return purchase_status in {"VOIDED", "FUNDING_RECLAIM_FAILED", "REFUND_FAILED"} or funding_status in {
        "RECLAIMING",
        "RECLAIMED",
        "RECLAIM_FAILED",
    }


# The AgentCard Organization MCP cap is org-wide (shared across every workspace
# using these credentials) and its retryAfter points at the top of the next
# window, so a refusal must wait that window out rather than burn its remaining
# attempts inside the same closed minute.
ABANDON_RATE_LIMIT_MAX_WAIT_SECONDS = 90.0


def _rate_limit_retry_delay(message: str) -> Optional[float]:
    """Seconds to wait for an upstream rate-limit refusal, or None if not rate-limited."""
    if "rate limit" not in message.lower() and "429" not in message:
        return None
    match = re.search(r'"retryAfterSeconds"\s*:\s*(\d+)', message)
    if match:
        return min(float(match.group(1)), ABANDON_RATE_LIMIT_MAX_WAIT_SECONDS)
    match = re.search(r'"retryAfter"\s*:\s*(\d+)', message)
    if match:
        remaining = float(match.group(1)) / 1000.0 - time.time()
        return min(max(remaining, 1.0), ABANDON_RATE_LIMIT_MAX_WAIT_SECONDS)
    return ABANDON_RATE_LIMIT_MAX_WAIT_SECONDS / 3


async def _start_payment_abandonment_with_recovery(
    base_url: str,
    agent_id: str,
    *,
    max_attempts: int = 3,
    retry_delay_seconds: float = 2,
    abandon_payment: Callable[[str, str], Awaitable[dict]] = abandon_test_payment,
    fetch_lifecycle: Callable[[str, str], Awaitable[dict]] = get_test_payment_lifecycle,
) -> dict:
    """Recover an accepted abandon POST whose HTTP response was disconnected.

    The mutation is idempotent, but immediately reposting it makes the provider
    cleanup race with itself and needlessly consumes AgentCard's request budget.
    First reconcile the indeterminate result through the read endpoint. Only
    retry the POST when no durable reclaim state exists yet.
    """
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    last_error: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await abandon_payment(base_url, agent_id)
        except Exception as error:
            # A 429 from the org-wide MCP cap is retryable too: it means the
            # request never ran, not that the lifecycle is broken. Without this
            # the gate reported "cleanup did not complete" for a lifecycle that
            # was already terminal-clean.
            rate_limit_delay = _rate_limit_retry_delay(str(error))
            if (
                not isinstance(error, httpx.TransportError)
                and "Failed to abandon test payment: 5" not in str(error)
                and rate_limit_delay is None
            ):
                raise
            last_error = error
            try:
                lifecycle = await fetch_lifecycle(base_url, agent_id)
                if _payment_abandonment_has_started(lifecycle):
                    print("    ♻ Recovered accepted payment abandonment after a disconnected response")
                    return lifecycle
            except Exception as read_error:
                last_error = read_error
            if attempt >= max_attempts:
                break
            wait_seconds = rate_limit_delay if rate_limit_delay is not None else retry_delay_seconds
            reason = "was rate limited" if rate_limit_delay is not None else "was indeterminate"
            print(
                f"    ⚠ Payment abandonment response {reason}; "
                f"retrying ({attempt}/{max_attempts}) in {wait_seconds:.0f}s: {error}"
            )
            await asyncio.sleep(wait_seconds)
    raise RuntimeError(
        f"Payment abandonment remained unavailable after {max_attempts} attempts: {last_error}"
    ) from last_error


# The setup fixture resolves the cardholder through the AgentCard org MCP, which
# intermittently rejects a healthy secret for a couple of seconds. Both actions are
# idempotent, so a 5xx is retried; 4xx (bad input, cardholder not ready) is not.
AGENTCARD_SETUP_RETRY_DELAYS_SECONDS = (2, 4, 8)


async def configure_benchmark_agentcard_setup(base_url: str, action: str) -> dict:
    headers = await _api_headers()
    for attempt, retry_delay in enumerate((*AGENTCARD_SETUP_RETRY_DELAYS_SECONDS, None), start=1):
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base_url}/api/test-payment/lifecycle/agentcard-setup",
                headers=headers,
                # The AgentCard integration must be reset/completed for the user the task actually runs
                # as. Hardcoding the default benchmark user left the run user's integration untouched,
                # so the setup fixture silently configured the wrong account.
                json={"userId": _current_benchmark_user_id(), "action": action},
            )
        if resp.status_code == 200:
            return resp.json()
        failure = f"Failed to {action} benchmark AgentCard setup: {resp.status_code} {resp.text[:300]}"
        if resp.status_code < 500 or retry_delay is None:
            raise RuntimeError(failure)
        print(f"    ⚠ AgentCard setup attempt {attempt} failed; retrying in {retry_delay}s ({failure})")
        await asyncio.sleep(retry_delay)
    raise AssertionError("unreachable: the final attempt raises or returns")


async def prepare_sandbox_payment_residual(task: BenchmarkTask, base_url: str) -> None:
    """Drain idle fixture headroom so this task's mint has a reclaimable pool transfer."""
    if task.production_only or "agentcard-lifecycle-sandbox" not in task.tags:
        return
    await configure_benchmark_agentcard_setup(base_url, "prepare-residual")


async def ensure_payment_lifecycle_cleanup(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    *,
    current_lifecycle: Optional[dict] = None,
    abandon_payment: Callable[[str, str], Awaitable[dict]] = abandon_test_payment,
    fetch_lifecycle: Callable[[str, str], Awaitable[dict]] = get_test_payment_lifecycle,
    poll_interval_seconds: float = 10,
) -> Optional[dict]:
    """Idempotently compensate issued benchmark cards before agent deletion."""
    if not agent_id or task.payment_card_request_action != "abandon":
        return None
    try:
        if current_lifecycle is not None:
            lifecycle_error = _validate_payment_lifecycle(
                task,
                {"_benchmark": {"payment_lifecycle": current_lifecycle}},
            )
            if lifecycle_error is None:
                print("    🧹 Reused already-reconciled payment lifecycle")
                return current_lifecycle

        lifecycle = await _start_payment_abandonment_with_recovery(
            base_url,
            agent_id,
            abandon_payment=abandon_payment,
            fetch_lifecycle=fetch_lifecycle,
        )
        lifecycle = await _wait_for_expected_payment_lifecycle(
            base_url,
            agent_id,
            task,
            lifecycle,
            poll_interval_seconds=poll_interval_seconds,
            fetch_lifecycle=fetch_lifecycle,
            recover_lifecycle=abandon_payment,
            resume_pending_after_seconds=PAYMENT_RECLAIM_RETRY_AFTER_SECONDS,
        )
        lifecycle_error = _validate_payment_lifecycle(
            task,
            {"_benchmark": {"payment_lifecycle": lifecycle}},
        )
        if lifecycle_error is not None:
            raise RuntimeError(lifecycle_error)
        print("    🧹 Confirmed payment-card transfer reclaim and Stripe refund")
        return lifecycle
    except AgentCardReleaseStall:
        raise
    except Exception as exc:
        print(f"    ⚠ Payment lifecycle cleanup failed for {agent_id[:12]}: {exc}")
        return None


async def get_attention_requests(base_url: str) -> list:
    """GET /api/attention-requests — returns pending requests for current user."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/attention-requests", headers=headers)
        if resp.status_code == 200:
            return _normalize_attention_requests_response(resp.json())
        return []


async def _agentcard_setup_attention_still_open_after_terminal(
    base_url: str,
    request_id: str,
    *,
    max_attempts: int = 3,
    retry_delay_seconds: float = 0.25,
    fetch_requests: Callable[[str], Awaitable[list]] = get_attention_requests,
) -> bool:
    """Refresh setup attention after terminal status instead of trusting a stale parallel poll."""
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    last_error: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            pending = await fetch_requests(base_url)
            setup_still_open = any(req.get("id") == request_id and _attention_request_is_open(req) for req in pending)
            if not setup_still_open or attempt >= max_attempts:
                return setup_still_open
        except Exception as error:
            last_error = error
            if attempt >= max_attempts:
                break
        await asyncio.sleep(retry_delay_seconds)
    raise RuntimeError(
        f"Terminal AgentCard setup attention remained unreadable after {max_attempts} reads: {last_error}"
    ) from last_error


async def _simulate_subscription_checkout_webhook(base_url: str, user_id: str) -> None:
    """Replay checkout.session.completed so subscription gates clear and agents resume."""
    import hashlib
    import hmac
    import json
    import time

    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET is required to simulate subscription webhook")

    stripe_customer_id = _subscription_webhook_stripe_customers.get(user_id)
    if not stripe_customer_id:
        raise RuntimeError(
            "gate-subscription-webhook-resume requires a provisioned Stripe billing customer; "
            "run gate-subscription-webhook-fixture before simulating the webhook"
        )

    sub_id = f"sub_bench_{user_id[:8]}"
    payload = json.dumps(
        {
            "id": f"evt_bench_{user_id[:8]}",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": f"cs_bench_{user_id[:8]}",
                    "object": "checkout.session",
                    "mode": "subscription",
                    "livemode": False,
                    "client_reference_id": user_id,
                    "subscription": sub_id,
                    "customer": stripe_customer_id,
                }
            },
        },
        separators=(",", ":"),
    )
    timestamp = int(time.time())
    signed = hmac.new(
        secret.encode(),
        f"{timestamp}.{payload}".encode(),
        hashlib.sha256,
    ).hexdigest()
    signature = f"t={timestamp},v1={signed}"

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{base_url}/webhooks/stripe",
            headers={
                "Content-Type": "application/json",
                "stripe-signature": signature,
            },
            content=payload.encode(),
        )
    if response.status_code != 200:
        raise RuntimeError(f"Simulated subscription webhook failed ({response.status_code}): {response.text[:300]}")


async def respond_to_attention_request(base_url: str, request_id: str, response: str) -> None:
    """POST /api/attention-requests/:id/respond"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        await client.post(
            f"{base_url}/api/attention-requests/{request_id}/respond",
            headers=headers,
            json={"response": response},
        )


# The agent names its browser task only after the paused task's bookkeeping
# (credential judge, diagnostics, recording): 46s after the request on one run.
AUTH_ASSISTANCE_TASK_ID_WAIT_SECONDS = 180


async def _browser_task_for_auth_assistance(base_url: str, agent_id: str, req: dict) -> str:
    """Wait for the agent's own message that names the browser task behind the request."""
    deadline = time.time() + AUTH_ASSISTANCE_TASK_ID_WAIT_SECONDS
    while True:
        data = await get_agent(base_url, agent_id)
        task_id = auth_assistance_user.browser_task_id(req, data.get("messages") or [])
        if task_id:
            return task_id
        if time.time() >= deadline:
            raise RuntimeError("the agent never posted the browser task for its sign-in-help request")
        await asyncio.sleep(3)


async def _respond_as_user_to_auth_assistance(base_url: str, agent_id: str, req: dict, user_response: str) -> None:
    """Play the user for a sign-in-help request on the hosted auth site."""
    headers = await _api_headers()
    req_id = str(req.get("id") or "")[:8]
    if user_response == "decline":
        await auth_assistance_user.decline(base_url, headers, req)
        site_id = str((auth_test_site.active_manifest() or {}).get("siteId") or "")
        if site_id:
            # Everything the site records from here on happened after the user said no.
            await auth_test_site.mark_run(base_url, headers, site_id, "user-declined")
        print(f"    🙅 Declined sign-in-help request {req_id}")
        return
    if user_response == "approve_app":
        if _attention_request_kind(req) != "auth_assistance":
            raise RuntimeError("app approval requires an auth-assistance request")
        app_approval = (auth_test_site.active_manifest() or {}).get("appApprovalUser")
        if not isinstance(app_approval, dict):
            raise RuntimeError("the site manifest carries no approval app for the user")
        task_id = await _browser_task_for_auth_assistance(base_url, agent_id, req)
        await auth_assistance_user.approve_app_as_user(base_url, headers, req, task_id, app_approval)
        print(f"    🙋 Approved sign-in in the user's app for sign-in-help request {req_id}")
        return
    if user_response != "sign_in":
        raise RuntimeError(f"unsupported sign-in-help user response: {user_response}")
    credentials = (auth_test_site.active_manifest() or {}).get("userSignIn")
    if not isinstance(credentials, dict):
        raise RuntimeError("the site manifest carries no password for the user to type")
    task_id = await _browser_task_for_auth_assistance(base_url, agent_id, req)
    landed = await auth_assistance_user.sign_in_as_user(
        base_url, headers, req, task_id, credentials, auth_test_site.sign_in_url(auth_test_site.active_manifest())
    )
    print(f"    🙋 Signed in as the user for sign-in-help request {req_id} (now on {landed})")


def _count_only_release_response() -> str:
    """Response used to unblock counted approval requests without approving side effects."""
    return "__REJECTED__"


def _approval_rejection_response() -> str:
    """Response value the app treats as an explicit approval rejection."""
    return "__REJECTED__"


async def get_agent_tree(base_url: str, bus_id: str) -> List[dict]:
    """GET /api/agents/tree?busId=X — all agents sharing a bus (root + descendants)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/tree", headers=headers, params={"busId": bus_id})
        if resp.status_code != 200:
            return []
        data = resp.json()
        return data.get("agents", [])


def _logical_tool_count_key(meta: dict) -> Optional[Tuple[str, str]]:
    """Return a logical tool-call key for benchmark count checks.

    Tool execution posts multiple FINISHED progress messages for long-running
    tools. Count only the user-facing completion for each logical tool call.
    """
    tool_name = meta.get("toolName")
    status = meta.get("toolStatus")
    if not tool_name:
        return None

    tool_call_id = meta.get("toolCallId")
    action_type = meta.get("action_type")

    if tool_name == "message_person":
        if status not in {"IN_PROGRESS", "FINISHED"} or not tool_call_id:
            return None
        return tool_name, str(tool_call_id)

    if status != "FINISHED":
        return None

    if action_type == "request_payment_card" and tool_call_id:
        return "request_payment_card", str(tool_call_id)

    if tool_name == "spawn_agent":
        if meta.get("agentType") == "browser" and tool_call_id:
            return "spawn_browser_agent", str(tool_call_id)
        if meta.get("subAgentId"):
            return None
        if not tool_call_id:
            return None
        return tool_name, str(tool_call_id)

    if tool_name == "spawn_sub_agent":
        if not tool_call_id:
            return None
        return tool_name, str(tool_call_id)

    if tool_name == "spawn_browser_agent":
        is_completion = action_type == "task_complete" or (
            action_type is None and meta.get("title") == "Browser automation complete"
        )
        if not is_completion or meta.get("subAgentId"):
            return None
        if not tool_call_id:
            return None
        return tool_name, str(tool_call_id)

    if tool_name == "spawn_claude_code_agent":
        if action_type != "task_complete" or meta.get("subAgentId"):
            return None
        if not tool_call_id:
            return None
        return tool_name, str(tool_call_id)

    if not tool_call_id:
        return None
    return tool_name, str(tool_call_id)


def _count_logical_tool_calls_from_messages(messages: List[dict]) -> Dict[str, int]:
    seen: set[Tuple[str, str]] = set()
    counts: Dict[str, int] = {}
    for msg in messages:
        meta = msg.get("metadata") or {}
        if msg.get("role") == "ASSISTANT":
            requested_calls = meta.get("tool_calls")
            if isinstance(requested_calls, list):
                for call in requested_calls:
                    if not isinstance(call, dict):
                        continue
                    tool_name = call.get("tool")
                    tool_call_id = call.get("tool_call_id")
                    if not isinstance(tool_name, str) or not tool_name or not tool_call_id:
                        continue
                    if tool_name == "spawn_agent" and call.get("type") == "browser":
                        tool_name = "spawn_browser_agent"
                    requested_key = (tool_name, str(tool_call_id))
                    if requested_key in seen:
                        continue
                    seen.add(requested_key)
                    counts[tool_name] = counts.get(tool_name, 0) + 1
        if meta.get("fromFastCache") and meta.get("toolStatus") == "FINISHED":
            child_counts = meta.get("childToolCounts")
            if isinstance(child_counts, dict):
                for tool_name, count in child_counts.items():
                    if isinstance(tool_name, str) and isinstance(count, int) and count > 0:
                        counts[tool_name] = counts.get(tool_name, 0) + count
        key = _logical_tool_count_key(meta)
        if not key or key in seen:
            continue
        seen.add(key)
        tool_name, _ = key
        counts[tool_name] = counts.get(tool_name, 0) + 1
    return counts


def _root_exact_tool_count_exceeded(task: BenchmarkTask, messages: List[dict]) -> Optional[str]:
    """Fail fast once a root-scoped exact tool-count contract cannot recover.

    A later agent state cannot reduce the number of logical calls already made.
    Waiting for the task timeout only hides the first bad boundary and can repeat
    external side effects, so exact root-count benchmarks stop immediately.
    """
    if task.tool_count_scope != "root" or not task.expected_tool_counts:
        return None
    actual_counts = _count_logical_tool_calls_from_messages(messages)
    for tool_name, expected_count in task.expected_tool_counts.items():
        actual = actual_counts.get(tool_name, 0)
        if actual > expected_count:
            return (
                f"Tool '{tool_name}' exceeded its exact root call limit during execution: "
                f"expected {expected_count}, got {actual}. Full counts: {actual_counts}"
            )
    return None


async def count_tree_tool_calls(base_url: str, root_agent_id: str) -> Dict[str, int]:
    """Count logical tool calls across all agents in the tree.

    Fetches messages for every agent in the tree and counts completed logical
    tool invocations. Long-running tools emit extra FINISHED status messages
    for observations/verifier progress; those are excluded.
    """
    agents = await get_agent_tree(base_url, root_agent_id)
    agent_ids = [a["agent_id"] for a in agents] if agents else [root_agent_id]

    counts: Dict[str, int] = {}
    for aid in agent_ids:
        try:
            data = await get_agent(base_url, aid)
        except Exception:
            continue
        for tool_name, count in _count_logical_tool_calls_from_messages(data.get("messages", [])).items():
            counts[tool_name] = counts.get(tool_name, 0) + count
    return counts


def _grep_message_uses_documents_source(text: str) -> bool:
    normalized = text.lower()
    return (
        "- **source**: documents" in normalized
        or '"source": "documents"' in normalized
        or "'source': 'documents'" in normalized
    )


def _extract_grep_document_source_filters(text: str) -> set[str]:
    providers: set[str] = set()
    for match in re.finditer(r"[\"']document_source[\"']\s*:\s*[\"']([^\"']+)[\"']", text):
        providers.add(match.group(1).strip().lower())
    for match in re.finditer(r"document_source\s*[:=]\s*([a-z0-9_ -]+)", text, re.IGNORECASE):
        providers.add(match.group(1).strip().lower())
    return providers


def _benchmark_message_text(msg: dict) -> str:
    """Return message body across live API and saved-run log shapes."""
    return str(msg.get("text") or msg.get("message") or "")


def _validate_user_data_prod_grep_messages(messages: List[dict]) -> Optional[str]:
    """Gate A (mechanical) for the prod user-data benchmark: every provider must be grepped from
    source='documents' via a completed explore spawn_agent. The FINAL answer's per-provider
    PASS/VERIFY checklist is no longer parsed structurally here — the agent's response_schema
    auto-generates at create time and its shape varies, so a rigid structured parse produced false
    'Seen: []' failures. That final-answer quality check now runs as a reusable, key-name-agnostic
    semantic judge over the agent's populated output schema
    (`_judge_output_recovers_expected_fields`)."""
    seen_providers: set[str] = set()
    matching_grep_calls = 0
    completed_explore_spawns = 0
    invalid_spawns: List[str] = []

    for msg in messages:
        meta = msg.get("metadata") or {}
        for tool_call in meta.get("tool_calls") or []:
            if tool_call.get("tool") != "spawn_agent":
                continue
            agent_type = tool_call.get("type")
            if agent_type != "explore":
                invalid_spawns.append(f"spawn_agent type={agent_type!r}")
            if tool_call.get("output_schema"):
                invalid_spawns.append("spawn_agent(type='explore') with output_schema")

        if meta.get("toolName") == "spawn_general_purpose_agent" and meta.get("toolStatus") == "FINISHED":
            invalid_spawns.append("spawn_general_purpose_agent")

        if (
            meta.get("toolName") == "spawn_agent"
            and meta.get("toolStatus") == "FINISHED"
            and not meta.get("subAgentId")
        ):
            completed_explore_spawns += 1

        if meta.get("toolName") != "grep" or meta.get("toolStatus") != "FINISHED":
            continue
        text = _benchmark_message_text(msg)
        if not _grep_message_uses_documents_source(text):
            continue
        matched = _extract_grep_document_source_filters(text) & USER_DATA_PROD_DOCUMENT_SOURCES
        if matched:
            matching_grep_calls += 1
            seen_providers.update(matched)

    if invalid_spawns:
        return (
            "User-data prod grep must use only spawn_agent(type='explore') without output_schema. "
            f"Invalid spawn calls: {invalid_spawns[:5]}"
        )

    missing = USER_DATA_PROD_DOCUMENT_SOURCES - seen_providers
    if missing:
        return (
            "User-data prod grep must include completed grep calls with source='documents' "
            "and filters.document_source for every V1 provider. "
            f"Missing: {sorted(missing)}. Seen: {sorted(seen_providers)}. "
            f"Matching grep calls: {matching_grep_calls}"
        )
    if completed_explore_spawns < 1:
        return (
            "User-data prod grep must complete at least one explore spawn_agent call "
            "before finalizing. Completed explore spawn_agent calls: "
            f"{completed_explore_spawns}"
        )
    return None


# ── Reusable semantic output evaluator (not overfitted to any one task) ──────────────────────────
# A key-name-agnostic LLM judge: given a task's REQUIRED output fields and the agent's POPULATED
# output schema, it scores 1.0 only when every required field's value is recoverable from that
# output — matched by MEANING, not by key name. This replaces brittle per-task structured parses and
# is reusable: e.g. "did the output contain a cost / a receipt id" without pinning the exact key.
# Declare a task's fields in SEMANTIC_OUTPUT_EXPECTATIONS; the judge does the mapping.
SEMANTIC_OUTPUT_EXPECTATIONS: Dict[str, Dict[str, Any]] = {
    # A response_schema ({"fields": [...]}) of REQUIRED output fields. The judge (the standard
    # verifier) must populate every field from the agent's output before scoring; field descriptions
    # carry the recovery rules and reach the verifier via build_verifier_prompt.
    "user-data-prod-grep": {
        "fields": [
            {
                "name": f"{provider}_evidence",
                "type": "str",
                "description": (
                    f"Provider '{provider}': recover EITHER concrete synced-document evidence (a "
                    f"documents/{provider}/... path or exact snippet) OR an honest statement that no "
                    f"{provider} document evidence is currently synced. An honest empty IS populatable "
                    f"(correct); a claim of verified evidence WITHOUT a documents source is fabricated "
                    f"and NOT populatable. Match by meaning, ignore the agent's key names."
                ),
            }
            for provider in ("chatgpt", "claude", "apple_notes", "obsidian")
        ]
    },
    "agent-payment": {
        "fields": [
            {
                "name": "order_confirmation_id",
                "type": "str",
                "description": (
                    "Recover the grounded order/payment confirmation id the browser agent read off "
                    "the checkout success page: a value shaped 'tp_' followed by exactly 8 lowercase "
                    "hex characters (for example tp_c9123127). Match by MEANING regardless of the "
                    "agent's key name — order_id, order_confirmation_id, payment_confirmation_id, "
                    "confirmation, receipt_id, etc. all count. It is populatable ONLY if such a "
                    "tp_<8 hex> id is actually present in the agent's produced output; an absent, "
                    "malformed, or fabricated id (not tp_ + 8 hex) is NOT populatable."
                ),
            },
        ]
    },
}


def _extract_agent_structured_output(messages: List[dict], root_agent_data: Optional[dict]) -> str:
    """The agent's POPULATED output — the response schema it generated plus the completion-summary
    structured outputs it filled in, with the actual final completion card. Unrelated
    assistant prose is excluded; task-specific expected fields remain unchanged."""
    from benchmarks.completion_evidence import completion_messages, completion_payload

    cards = [completion_payload(message) for message in completion_messages(messages)]
    populated_outputs = [output for card in cards for output in (card.get("outputs") if isinstance(card.get("outputs"), list) else []) if isinstance(output, dict)]
    agent = (root_agent_data or {}).get("agent") or {}
    blob = {"generated_response_schema": agent.get("response_schema"),
            "populated_outputs": populated_outputs, "completion_cards": cards,
            "structured_output": agent.get("structured_output", agent.get("structuredOutput"))}
    return json.dumps(blob, default=str, ensure_ascii=False)


async def _judge_output_recovers_expected_fields(
    root_agent_id: str,
    agent_output_blob: str,
    expected_schema: Dict[str, Any],
    task_label: str,
) -> Optional[str]:
    """Reusable semantic output judge (see SEMANTIC_OUTPUT_EXPECTATIONS). The judge is the STANDARD
    verifier pointed at the task's expected output schema and fed the agent's populated output as
    evidence: per build_verifier_prompt / _build_verifier_json_schema it POPULATES every expected
    field FIRST, then emits reasoning, then scores 1.0 iff each field is recoverable (by meaning, any
    key name). Returns None on pass (score == 1.0), else a failure reason carrying the judge's
    populated output + reasoning. No bespoke judge system prompt — reuses the approved verifier."""
    from helpers.llm import check_progress
    from utils.prompts import build_verifier_prompt

    if not agent_output_blob.strip() or agent_output_blob.strip() in ("{}", "null"):
        return f"{task_label}: agent produced no populated output schema to judge."
    if not expected_schema.get("fields"):
        return None

    claude_auth = await _benchmark_judge_claude_auth_kwargs()
    verifier_prompt = build_verifier_prompt(expected_schema)

    async def judge() -> dict:
        return await check_progress(
            context=[
                {
                    "role": "USER",
                    "text": (
                        "Populate each required output field from the agent's produced output below. A "
                        "field is populatable when its value is recoverable by MEANING (any key name) or "
                        "the output honestly reports no data for it."
                    ),
                },
                {"role": "TOOL", "text": f"AGENT POPULATED OUTPUT:\n{agent_output_blob}",
                 "metadata": {"benchmark_final_evidence": True}},
            ],
            verifier_system_prompt=verifier_prompt,
            response_schema=expected_schema,
            call_site="semantic_output_field_recovery_judge",
            agent_id=root_agent_id,
            **claude_auth,
        )

    judged = await _judge_until_verdict(judge)
    score = float(judged.get("score", 0.0))
    if score >= 1.0:
        return None
    populated = json.dumps(judged.get("output"), default=str)[:400]
    reasoning = str(judged.get("reasoning") or "no reasoning")
    return (
        f"{task_label}: semantic output judge scored {score} (need 1.0). "
        f"Populated output: {populated}. Reason: {reasoning}"
    )


async def validate_user_data_prod_grep_contract(base_url: str, root_agent_id: str) -> Optional[str]:
    agents = await get_agent_tree(base_url, root_agent_id)
    agent_ids = [a["agent_id"] for a in agents] if agents else [root_agent_id]

    messages: List[dict] = []
    for aid in agent_ids:
        try:
            data = await get_agent(base_url, aid)
        except Exception:
            continue
        messages.extend(data.get("messages", []))

    # Gate A (mechanical): every provider grepped from source='documents' via a completed explore.
    gate_a_error = _validate_user_data_prod_grep_messages(messages)
    if gate_a_error is not None:
        return gate_a_error
    # Gate B (semantic, reusable): the agent's populated output must let us recover a checklist row
    # for every provider — key-name-agnostic, so an auto-generated schema of any shape passes.
    root_data = await get_agent(base_url, root_agent_id)
    agent_output_blob = _extract_agent_structured_output(messages, root_data)
    return await _judge_output_recovers_expected_fields(
        root_agent_id,
        agent_output_blob,
        SEMANTIC_OUTPUT_EXPECTATIONS["user-data-prod-grep"],
        "user-data-prod-grep",
    )


def _validate_tool_count_expectations(
    actual_counts: Dict[str, int],
    min_tool_counts: Optional[dict],
    forbidden_tools: List[str],
) -> Optional[str]:
    """Validate minimum and forbidden tool-count benchmark expectations."""
    for tool_name, minimum in (min_tool_counts or {}).items():
        actual = actual_counts.get(tool_name, 0)
        if actual < minimum:
            return (
                f"Tool '{tool_name}': expected at least {minimum} call(s), got {actual}. Full counts: {actual_counts}"
            )

    for tool_name in forbidden_tools:
        actual = actual_counts.get(tool_name, 0)
        if actual > 0:
            return f"Forbidden tool '{tool_name}' was called {actual} time(s). Full counts: {actual_counts}"

    return None


async def post_message(base_url: str, agent_id: str, message: str) -> bool:
    """POST /api/agents/:id/messages — send a user message (unblocks send_message_to_user waits)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/agents/{agent_id}/messages",
            headers=headers,
            json={"message": message, "role": "USER"},
        )
        return resp.status_code in (200, 201)


async def post_tool_status_message(
    base_url: str,
    agent_id: str,
    *,
    title: str,
    status: str,
    metadata: Optional[dict[str, Any]] = None,
) -> bool:
    """Post a metadata-only tool row without adding visible text content."""

    headers = await _api_headers()
    body = {
        "message": "",
        "role": "TOOL",
        "metadata": {
            "toolName": "world_model_update",
            "toolStatus": status,
            "title": title,
            "simulated": True,
            "source": "benchmark_simulate_preflight",
            **(metadata or {}),
        },
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{base_url}/api/agents/{agent_id}/messages", headers=headers, json=body)
        return resp.status_code in (200, 201)


async def post_world_model_update_events(base_url: str, agent_id: str) -> None:
    if not _WORLD_MODEL_UPDATE_EVENTS:
        return
    for event in _WORLD_MODEL_UPDATE_EVENTS:
        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        ok = await post_tool_status_message(
            base_url,
            agent_id,
            title=str(event.get("title") or "World Model Updating"),
            status=str(event.get("status") or "IN_PROGRESS"),
            metadata={
                "worldModelStage": event.get("title"),
                "worldModelUpdate": metadata,
            },
        )
        if not ok:
            print(f"    ⚠ Failed to post world model status row for agent:{agent_id[:12]}")
            return


async def pause_agent(base_url: str, agent_id: str) -> bool:
    """POST /api/agents/:id/pause — pause root agent (children discover via polling)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{base_url}/api/agents/{agent_id}/pause", headers=headers)
        return resp.status_code in (200, 204)


def _finished_for_each_checkpoint_index(messages: list[dict]) -> int | None:
    for index in range(len(messages) - 1, -1, -1):
        metadata = messages[index].get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if (
            metadata.get("toolName") == "spawn_general_purpose_agent_for_each"
            and metadata.get("toolStatus") == "FINISHED"
        ):
            return index
    return None


async def poll_agent_until_message_index(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    checkpoint_index: int,
    checkpoint_source_boundary: str = "message-index",
) -> dict:
    """Poll until the root transcript reaches a durable checkpoint boundary, then pause."""
    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)
    deadline = time.time() + resolved_timeout
    required_count = checkpoint_index + 1
    last_count = -1
    while time.time() < deadline:
        data = await get_agent(base_url, agent_id)
        messages = data.get("messages", []) or []
        status = (data.get("agent") or {}).get("status")
        if len(messages) != last_count:
            print(f"    checkpoint source progress: root_messages={len(messages)}/{required_count}")
            last_count = len(messages)
        boundary_index = (
            _finished_for_each_checkpoint_index(messages) if checkpoint_source_boundary == "for-each-finished" else None
        )
        if boundary_index is not None:
            if not await pause_agent(base_url, agent_id):
                raise RuntimeError(f"Failed to pause checkpoint source agent {agent_id}")
            paused = await get_agent(base_url, agent_id)
            print(
                "    checkpoint source paused at "
                f"for_each_finished_index={boundary_index} "
                f"root_messages={len(paused.get('messages', []) or [])}"
            )
            return paused
        if len(messages) >= required_count:
            if not await pause_agent(base_url, agent_id):
                raise RuntimeError(f"Failed to pause checkpoint source agent {agent_id}")
            paused = await get_agent(base_url, agent_id)
            print(f"    checkpoint source paused at root_messages={len(paused.get('messages', []) or [])}")
            return paused
        if status in TERMINAL_STATUSES:
            raise RuntimeError(
                f"Agent reached terminal status {status} before checkpoint index {checkpoint_index} "
                f"(root_messages={len(messages)})"
            )
        await asyncio.sleep(POLL_INTERVAL)
    raise TimeoutError(
        f"Timed out waiting for checkpoint index {checkpoint_index} "
        f"(last root_messages={last_count}, timeout={resolved_timeout}s)"
    )


def export_checkpoint_source_from_local_db(
    agent_id: str,
    *,
    source_out: Path,
    tree_out: Path | None,
) -> None:
    """Export a paused local source agent into the checkpoint clone format."""
    command = [
        "npx",
        "tsx",
        "scripts/export-agent-checkpoint.ts",
        "--agent-id",
        agent_id,
        "--source-out",
        str(source_out),
    ]
    if tree_out is not None:
        command.extend(["--tree-out", str(tree_out)])
    env = {**os.environ}
    result = subprocess.run(
        command,
        cwd=REPO_ROOT / "back-end",
        env=env,
        capture_output=True,
        text=True,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"Checkpoint export failed with exit {result.returncode}")


async def post_attachment_message(base_url: str, agent_id: str, file_pointers: List[dict]) -> bool:
    """POST /api/agents/:id/messages with file attachments so the agent can see them."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/agents/{agent_id}/messages",
            headers=headers,
            json={"message": "", "role": "USER", "attachments": file_pointers},
        )
        return resp.status_code in (200, 201)


async def upload_attachment(base_url: str, agent_id: str, filepath: str) -> dict:
    """Upload a file attachment for an agent. Raises if the required FilePointer is unavailable."""
    headers = await _api_headers()
    # Remove Content-Type — httpx sets multipart boundary automatically
    headers.pop("Content-Type", None)

    filename = os.path.basename(filepath)
    async with httpx.AsyncClient(timeout=60) as client:
        with open(filepath, "rb") as f:
            resp = await client.post(
                f"{base_url}/api/agents/{agent_id}/attachments",
                headers=headers,
                files={"file": (filename, f)},
            )
        if resp.status_code in (200, 201):
            data = resp.json()
            pointer = data.get("file_pointer") or data.get("filePointer")
            if isinstance(pointer, dict):
                return pointer
            raise RuntimeError(f"Attachment upload for {filename} returned no FilePointer")
        raise RuntimeError(f"Attachment upload failed for {filename}: HTTP {resp.status_code}: {resp.text[:500]}")


# ============================================================
# Polling loop
# ============================================================


async def _fetch_tree_stats(base_url: str, agent_id: str) -> dict:
    """
    Fetch tree-level aggregate stats for stall detection and progress reporting.

    Returns dict with:
        agent_count, total_messages, total_cost_cents, active_count, failed_count,
        tree_tokens_in, tree_tokens_out,
        error_agents (list of dicts with agent_id, status, error details),
        all_agents (list of raw agent dicts from tree API)
    """
    try:
        agents = await get_agent_tree(base_url, agent_id)
        if not agents:
            return {
                "agent_count": 0,
                "total_messages": 0,
                "total_cost_cents": 0,
                "active_count": 0,
                "failed_count": 0,
                "tree_tokens_in": 0,
                "tree_tokens_out": 0,
                "error_agents": [],
                "all_agents": [],
            }

        total_msgs = sum(a.get("message_count", 0) for a in agents)
        total_cost = sum(a.get("tree_cost_cents", 0) for a in agents)
        tree_tokens_in, tree_tokens_out = _tree_token_totals_from_agents(agents, agent_id)
        active = [a for a in agents if a.get("status") == "ACTIVE"]
        failed = [a for a in agents if a.get("status") in ("FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED")]

        return {
            "agent_count": len(agents),
            "total_messages": total_msgs,
            "total_cost_cents": total_cost,
            "active_count": len(active),
            "failed_count": len(failed),
            "tree_tokens_in": tree_tokens_in,
            "tree_tokens_out": tree_tokens_out,
            "error_agents": [{"agent_id": a.get("agent_id", "")[:12], "status": a.get("status")} for a in failed],
            "all_agents": agents,
        }
    except Exception:
        return {
            "agent_count": 0,
            "total_messages": 0,
            "total_cost_cents": 0,
            "active_count": 0,
            "failed_count": 0,
            "tree_tokens_in": 0,
            "tree_tokens_out": 0,
            "error_agents": [],
            "all_agents": [],
        }


def _as_nonnegative_int(value) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(parsed, 0)


def _tree_token_totals_from_agents(agents: list[dict], root_agent_id: str) -> tuple[int, int]:
    if not agents:
        return 0, 0
    root = next((a for a in agents if a.get("agent_id") == root_agent_id or a.get("id") == root_agent_id), None)
    candidates = [root] if root else []
    candidates.extend(agents)
    best_in = 0
    best_out = 0
    for agent in candidates:
        if not agent:
            continue
        tokens_in = _as_nonnegative_int(agent.get("tokens_in", agent.get("tokensIn")))
        tokens_out = _as_nonnegative_int(agent.get("tokens_out", agent.get("tokensOut")))
        best_in = max(best_in, tokens_in)
        best_out = max(best_out, tokens_out)
        if agent is root and (tokens_in > 0 or tokens_out > 0):
            return tokens_in, tokens_out
    return best_in, best_out


def _merge_tool_and_tree_tokens(
    tool_tokens_in: int,
    tool_tokens_out: int,
    tree_tokens_in: int,
    tree_tokens_out: int,
    *,
    tool_tokens_cover_tree: bool,
) -> tuple[int, int]:
    """Combine tool-usage and root tree counters without dropping chat-loop tokens.

    Current workers write chat-loop calls to ToolUsage, so tool totals usually
    already cover the root tree counters. Older backends return cache counters
    without aggregate token fields; in that case cache totals and root tree
    counters are separate inputs and must be added.
    """
    tool_tokens_in = _as_nonnegative_int(tool_tokens_in)
    tool_tokens_out = _as_nonnegative_int(tool_tokens_out)
    tree_tokens_in = _as_nonnegative_int(tree_tokens_in)
    tree_tokens_out = _as_nonnegative_int(tree_tokens_out)
    if not tool_tokens_cover_tree:
        return tool_tokens_in + tree_tokens_in, tool_tokens_out + tree_tokens_out
    tokens_in = max(tool_tokens_in, tree_tokens_in)
    tokens_out = max(tool_tokens_out, tree_tokens_out)
    return tokens_in, tokens_out


async def _fetch_message_counts(base_url: str, agent_ids: List[str]) -> Dict[str, int]:
    """Fetch actual message-row counts for agents whose tree counters can lag."""
    if not agent_ids:
        return {}

    async def _fetch_one(aid: str) -> Tuple[str, Optional[int]]:
        try:
            data = await get_agent(base_url, aid)
            return aid, len(data.get("messages", []))
        except Exception:
            return aid, None

    counts: Dict[str, int] = {}
    results = await asyncio.gather(*(_fetch_one(aid) for aid in agent_ids), return_exceptions=False)
    for aid, count in results:
        if count is not None:
            counts[aid] = count
    return counts


def suite_name_for_error(args) -> str:
    """Best-effort suite label for error messages — mirrors what the user ran."""
    if args.suite:
        return args.suite
    task_names = task_names_from_args(args)
    if task_names:
        return "--task " + ",".join(task_names)
    return "smoke"


def _detect_infra_errors_from_fly(agent_ids: List[str]) -> List[str]:
    """
    Scan Fly.io streaming logs for infrastructure-level errors across all agents.
    Returns list of error descriptions.
    """
    from benchmarks.logs import _fly_collector, _is_remote_worker_log_placeholder

    if not _fly_collector:
        return []

    errors = []
    for aid in agent_ids:
        logs = _fly_collector.get_logs_for_agent(aid)
        for log_line in logs:
            # Collector placeholders ("[fly.io] 0 logs ... (N total captured)")
            # are not log content; their captured-line count can contain "429".
            if _is_remote_worker_log_placeholder(log_line):
                continue
            ll = log_line.lower()
            if any(
                kw in ll
                for kw in (
                    "session limit reached",
                    "429",
                    "too many requests",
                    "connection refused",
                    "all reconnection attempts failed",
                    "oom",
                    "out of memory",
                    "killed",
                )
            ):
                errors.append(log_line[:200])
    return errors


def benchmark_wall_clock_backstop_seconds() -> int:
    """Independent safety ceiling; catalog and Polar step budgets remain intact."""
    value = os.environ.get("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS", "7200")
    if not value.isascii() or not value.isdigit() or int(value) <= 0:
        raise ValueError("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS must be a positive integer")
    return int(value)


def agent_execution_backstop_seconds(task: Optional[BenchmarkTask] = None) -> int:
    """An operator-set backstop is a hard cap; only the default yields to a longer task timeout."""
    seconds = benchmark_wall_clock_backstop_seconds()
    if task is None or "BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS" in os.environ:
        return seconds
    resolved = getattr(task, "_resolved_timeout_seconds", None)
    if resolved is None:
        resolved = task.timeout_seconds
    if isinstance(resolved, (int, float)) and not isinstance(resolved, bool) and resolved > seconds:
        return int(resolved)
    return seconds


async def poll_agent(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    realtime_monitor: Optional[SupabaseRealtimeSmokeMonitor] = None,
) -> Tuple[dict, int, int, Optional[str]]:
    """Bound polling for callers that have already prepared an agent."""

    async def execute(snapshot: dict):
        return await _poll_agent(base_url, agent_id, task, realtime_monitor, snapshot)

    return await _run_with_agent_execution_backstop(base_url, agent_id, execute, task=task)


async def _run_with_agent_execution_backstop(
    base_url: str,
    agent_id: str,
    execute: Callable[[dict], Awaitable[Any]],
    started_at: Optional[float] = None,
    task: Optional[BenchmarkTask] = None,
) -> Any:
    """Bound all post-create execution, including preparation and checkpoints."""
    seconds = agent_execution_backstop_seconds(task)
    print(f"    🛑 Agent execution wall-clock backstop: {seconds}s")
    snapshot: dict = {}
    started_at = asyncio.get_running_loop().time() if started_at is None else started_at
    deadline = started_at + seconds
    execution = asyncio.create_task(execute(snapshot))
    original_error = None
    try:
        finished, _ = await asyncio.wait({execution}, timeout=max(0.0, deadline - asyncio.get_running_loop().time()))
        if finished:
            return await execution
    except BaseException as error:
        original_error = error
    if original_error is None:
        print(f"    ⏰ Agent execution deadline reached after {seconds}s; cancelling poll")

    # Both deadline expiry and external cancellation own the same finite drain.
    # Repeated caller cancellation must neither abandon it nor restart its grace.
    grace_end = asyncio.get_running_loop().time() + 5.0

    async def drain_execution():
        for _ in range(5):
            remaining = grace_end - asyncio.get_running_loop().time()
            if execution.done() or remaining <= 0:
                break
            execution.cancel()
            finished, _ = await asyncio.wait({execution}, timeout=min(1.0, remaining))
            if finished:
                break
        if not execution.done():
            raise RuntimeError("Agent execution did not stop after bounded cancellation")

    cleanup = asyncio.create_task(drain_execution())
    while True:
        try:
            await asyncio.shield(cleanup)
            break
        except asyncio.CancelledError as error:
            if original_error is None:
                original_error = error
            if cleanup.cancelled():
                raise RuntimeError("Agent execution cleanup was cancelled before joining") from error
        except BaseException as cleanup_error:
            raise cleanup_error from original_error
    try:
        execution.result()
    except asyncio.CancelledError:
        pass
    except BaseException as execution_error:
        if execution_error is original_error:
            raise
        raise execution_error from original_error
    if original_error is not None:
        raise original_error
    # Stop paid work before diagnostics; the normal task path subsequently
    # waits for terminal browser evidence and performs payment/agent cleanup.
    if not await pause_agent(base_url, agent_id):
        raise RuntimeError(f"Could not pause agent after {seconds}s wall-clock backstop")
    data = await get_agent(base_url, agent_id)
    metadata = dict(snapshot.get("_benchmark") or {})
    metadata["wall_clock_backstop_seconds"] = seconds
    data["_benchmark"] = {**data.get("_benchmark", {}), **metadata}
    reason = f"Timeout after {seconds}s (wall-clock backstop={seconds}s)"
    print(f"    ⏰ {reason}")
    return data, metadata.get("approvals_triggered", 0), metadata.get("approvals_resolved", 0), reason


async def _stop_realtime_tree_capture(
    task: asyncio.Task, stop: asyncio.Event, *, attempts: int = 5, interval: float = 2.0
) -> None:
    """Retire best-effort tree capture before finalizing the evaluated result.

    A Realtime subscription can absorb a cancellation while reconnecting. Keep
    an explicit stop condition and retry cancellation under a finite deadline;
    a capture that still owns work is an infrastructure error, not a task FAIL.
    """
    stop.set()
    for _ in range(attempts):
        if task.done():
            break
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=interval)
        if done:
            break
    if not task.done():
        raise RuntimeError("Realtime tree capture did not stop after bounded cancellation")
    await asyncio.gather(task, return_exceptions=True)


async def _poll_agent(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    realtime_monitor: Optional[SupabaseRealtimeSmokeMonitor] = None,
    timeout_snapshot: Optional[dict] = None,
) -> Tuple[dict, int, int, Optional[str]]:
    """
    Poll agent until terminal state, timeout, or early-failure.
    Monitors the ENTIRE agent tree for stall detection, not just the root.

    Returns: (final_agent_data, approvals_triggered, approvals_resolved, early_fail_reason)
    early_fail_reason is non-None when a fail-fast condition tripped (per-agent
    stall, context validation error, dynamic timeout). The caller overrides
    pass→fail based on this.
    """
    start = time.monotonic()
    last_activity_time = start  # tracks ANY activity across the entire tree
    last_cost_change_time = start  # tree LLM cost growth (CC in-place progress)
    last_world_model_activity_time = start  # in-flight WMH predictions (simulated tools)
    prev_tree_message_count = 0
    prev_tree_agent_count = 0
    prev_tree_cost = 0
    prev_root_message_count = 0
    approvals_triggered = 0
    approvals_resolved = 0
    replied_waiting_msgs: set = set()  # track isWaitingForUser messages we've already replied to
    last_tree_poll = 0.0  # timestamp of last tree-level poll
    last_progress_print = 0.0  # timestamp of last progress log
    last_tree_stats: dict = {}  # cached tree stats
    last_violation_count = 0  # track violations to only print new ones
    # Per-agent stall tracking: agent_id → {count, last_change_time, status}.
    # Includes the root plus every descendant appearing in the tree endpoint.
    per_agent_state: Dict[str, dict] = {}
    stall_limit_seconds = agent_stall_limit_seconds(task)
    seen_attention_ids: set[str] = set()
    seen_attention_kinds: List[str] = []
    validated_payment_receipt_request_id: Optional[str] = None
    expected_gate_evidence: Optional[dict] = None
    subscription_checkout_evidence: Optional[dict] = None
    write_lock_prerequisite_request_id: Optional[str] = None
    agentcard_setup_attention_seen = False
    agentcard_setup_attention_id: Optional[str] = None
    attention_requests_seen: list[dict] = []
    chat_assistant_seen_at: Optional[float] = None
    payment_card_action_completed = False
    task._mid_run_feedback_posted = False
    task._mid_run_feedback_initial_schema = None
    task._mid_run_feedback_evidence = None

    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)
    wall_clock_disabled = polar_wall_clock_disabled(task) or resolved_timeout in (None, 0)
    step_budget = polar_browser_step_budget(task)

    while True:
        elapsed = time.monotonic() - start
        if not wall_clock_disabled and resolved_timeout and elapsed > resolved_timeout:
            reason = (
                f"Timeout after {elapsed:.0f}s (task timeout={resolved_timeout}s)"
                f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}"
                f" | Cache/cost: python agents/benchmarks/run_benchmark.py --compare <run.json>"
            )
            print(f"    ⏰ {reason}")
            data = await get_agent(base_url, agent_id)
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "approvals_triggered": approvals_triggered,
                "approvals_resolved": approvals_resolved,
                "attention_requests_seen": list(attention_requests_seen),
            }
            if expected_gate_evidence:
                data["_benchmark"]["expected_gate_seen"] = True
                data["_benchmark"]["expected_gate"] = expected_gate_evidence["gate"]
                data["_benchmark"]["expected_gate_request_id"] = expected_gate_evidence["request_id"]
            if validated_payment_receipt_request_id:
                data["_benchmark"]["expected_payment_receipt_seen"] = True
                data["_benchmark"]["expected_payment_receipt_request_id"] = validated_payment_receipt_request_id
            _mark_expected_gate_from_data(task, data)
            return data, approvals_triggered, approvals_resolved, reason

        # Hot-path HTTP — fetch root agent and (if the task handles approvals)
        # attention-requests in parallel. Saves ~150ms per poll.
        fetch_approvals_now = task.approval_handling in (
            "auto_approve",
            "ignore",
            "prompt_user",
            "count_only",
        )
        try:
            if fetch_approvals_now:
                data, _pending_attention = await asyncio.gather(
                    get_agent(base_url, agent_id),
                    get_attention_requests(base_url),
                    return_exceptions=False,
                )
            else:
                data = await get_agent(base_url, agent_id)
                _pending_attention = []
        except AgentNotFoundError:
            print(f"    ⚠ Agent {agent_id[:12]} returned 404 — deleted or expired")
            return (
                {"agent": {"status": "DELETED"}, "messages": []},
                approvals_triggered,
                approvals_resolved,
                "Agent returned 404",
            )
        except Exception as e:
            print(f"    ⚠ Poll error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
            continue

        agent = data.get("agent", {})
        status = agent.get("status", "UNKNOWN")
        messages = data.get("messages", [])
        root_msg_count = len(messages)
        data["_benchmark"] = {
            **data.get("_benchmark", {}),
            "approvals_triggered": approvals_triggered,
            "approvals_resolved": approvals_resolved,
            "attention_requests_seen": list(attention_requests_seen),
        }
        from benchmarks.parked_browser_page import measurement_required, parked_page_observation
        if measurement_required(task):
            data["_benchmark"]["pending_attention_requests"] = [
                {**_attention_request_evidence(req), "agent_id": req.get("agentId") or req.get("agent_id")}
                for req in _pending_attention if _attention_request_is_open(req)
            ]
        if subscription_checkout_evidence:
            data["_benchmark"]["subscription_checkout"] = subscription_checkout_evidence
        if timeout_snapshot is not None:
            timeout_snapshot.update(data)
        if seen_attention_kinds:
            data["_benchmark"]["attention_request_kind_seen"] = seen_attention_kinds[-1]
            if task.expected_attention_kind:
                data["_benchmark"]["expected_attention_kind_seen"] = task.expected_attention_kind
            if task.expected_attention_kind_any_of:
                data["_benchmark"]["expected_attention_kind_any_of"] = list(task.expected_attention_kind_any_of)
            if task.expected_attention_kinds:
                data["_benchmark"]["expected_attention_kinds_seen"] = list(seen_attention_kinds)
        if (task.approval_handling == "ignore" and measurement_required(task)
                and seen_attention_kinds and parked_page_observation(
                    data, auth_test_site.active_manifest(), _current_benchmark_user_id())):
            return data, approvals_triggered, approvals_resolved, None
        if validated_payment_receipt_request_id:
            data["_benchmark"]["expected_payment_receipt_seen"] = True
            data["_benchmark"]["expected_payment_receipt_request_id"] = validated_payment_receipt_request_id
        if expected_gate_evidence:
            data["_benchmark"]["expected_gate_seen"] = True
            data["_benchmark"]["expected_gate"] = expected_gate_evidence["gate"]
            data["_benchmark"]["expected_gate_request_id"] = expected_gate_evidence["request_id"]
        if write_lock_prerequisite_request_id:
            data["_benchmark"]["write_lock_prerequisite_auto_approved"] = True
            data["_benchmark"]["write_lock_prerequisite_request_id"] = write_lock_prerequisite_request_id

        if task.success_on_plan:
            accepted_plan = find_accepted_plan(messages)
            if accepted_plan is not None:
                # Plan-only A/B: the accepted plan is the deliverable. Pause the
                # agent right here so the DAG never executes (no browser sessions,
                # no spend beyond planning); the runner deletes it after grading.
                data["_benchmark"]["plan"] = accepted_plan
                if status not in TERMINAL_STATUSES and not await pause_agent(base_url, agent_id):
                    print(f"    ⚠ Could not pause plan-only agent {agent_id[:12]} after its plan was accepted")
                print(
                    f"    ✅ Plan accepted ({len(accepted_plan.get('tasks') or [])} tasks) — plan-only task stops here"
                )
                return data, approvals_triggered, approvals_resolved, None

        if step_budget and status not in TERMINAL_STATUSES:
            browser_steps = _agent_class_step_counts(data).get("browser", {})
            used_steps = max(browser_steps.values()) if browser_steps else 0
            if used_steps >= step_budget:
                data["_benchmark"]["step_budget_reached"] = True
                data["_benchmark"]["browser_steps"] = used_steps
                data["_benchmark"]["browser_step_budget"] = step_budget
                print(f"    🧭 Browser step budget reached: {used_steps}/{step_budget} — pausing for polar judge")
                try:
                    await pause_agent(base_url, agent_id)
                    data = await get_agent(base_url, agent_id)
                    data["_benchmark"] = {
                        **data.get("_benchmark", {}),
                        "step_budget_reached": True,
                        "browser_steps": used_steps,
                        "browser_step_budget": step_budget,
                        "approvals_triggered": approvals_triggered,
                        "approvals_resolved": approvals_resolved,
                        "attention_requests_seen": list(attention_requests_seen),
                    }
                except Exception as pause_error:
                    print(f"    ⚠ Failed to pause after step budget: {pause_error}")
                # Not an early-fail: Odysseys grades whatever trajectory fit the budget.
                return data, approvals_triggered, approvals_resolved, None

        exact_count_error = _root_exact_tool_count_exceeded(task, messages)
        if exact_count_error:
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "exact_tool_count_error": exact_count_error,
            }
            print(f"    🚨 {exact_count_error}")
            return data, approvals_triggered, approvals_resolved, exact_count_error

        if (
            task.payment_card_request_action == "abandon"
            and not payment_card_action_completed
            and any(
                isinstance(message.get("metadata"), dict) and message["metadata"].get("title") == "Payment card ready"
                for message in messages
            )
        ):
            remaining_task_budget = None if wall_clock_disabled else max(0, resolved_timeout - (time.monotonic() - start))
            if remaining_task_budget is not None and remaining_task_budget <= 0:
                raise RuntimeError(f"Payment reconciliation started after the task timeout ({resolved_timeout}s)")
            try:
                # Compensation after a failed task remains a separate owner;
                # this success path must fit the task's remaining execution time.
                async with asyncio.timeout(remaining_task_budget):
                    lifecycle = await _start_payment_abandonment_with_recovery(base_url, agent_id)
                    # Retain exact allocation ownership before reconciliation can raise.
                    data["_benchmark"] = {**data.get("_benchmark", {}), "payment_lifecycle": lifecycle}
                    if timeout_snapshot is not None:
                        timeout_snapshot.update(data)
                    remaining_task_budget = (
                        None if wall_clock_disabled else max(0, resolved_timeout - (time.monotonic() - start))
                    )
                    if remaining_task_budget is not None and remaining_task_budget <= 0:
                        raise TimeoutError("Payment abandonment response arrived after the task deadline")
                    lifecycle = await _wait_for_expected_payment_lifecycle(
                        base_url,
                        agent_id,
                        task,
                        lifecycle,
                        timeout_seconds=(420 if remaining_task_budget is None else min(420, remaining_task_budget)),
                        recover_lifecycle=abandon_test_payment,
                        resume_pending_after_seconds=PAYMENT_RECLAIM_RETRY_AFTER_SECONDS,
                    )
            except TimeoutError as timeout_error:
                raise RuntimeError(
                    f"Payment reconciliation exceeded the task timeout ({resolved_timeout}s)"
                ) from timeout_error
            if not wall_clock_disabled and time.monotonic() - start >= resolved_timeout:
                raise RuntimeError(
                    f"Payment reconciliation response arrived after the task timeout ({resolved_timeout}s)"
                )
            payment_card_action_completed = True
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "payment_card_request_action": "abandon",
                "payment_lifecycle": lifecycle,
                "expected_payment_receipt_seen": bool(task.expected_payment_receipt and approvals_triggered > 0),
                "expected_attention_kind_seen": task.expected_attention_kind,
            }
            print("    ✅ Abandoned issued payment card and reconciled funding")
            return data, approvals_triggered, approvals_resolved, None

        if realtime_monitor and realtime_monitor.failure_reason:
            realtime_failure = realtime_monitor.reconcile_snapshot(messages)
            if realtime_failure and status in TERMINAL_STATUSES:
                return data, approvals_triggered, approvals_resolved, realtime_failure

        # Validate context well-formedness. Any error-severity violation is an
        # instant fail — don't keep polling, the agent will not recover.
        # Skip tool_result_pairing during polling — tools may still be executing.
        violations = validate_context(messages)
        poll_violations = [v for v in violations if v.rule != "tool_result_pairing"]
        if len(poll_violations) > last_violation_count:
            new_violations = poll_violations[last_violation_count:]
            errors = [v for v in new_violations if v.severity == "error"]
            warnings = [v for v in new_violations if v.severity == "warning"]
            if errors:
                print(f"    🚨 CONTEXT ERRORS ({len(errors)}):")
                for v in errors:
                    print(f"       [{v.rule}] {v.message}")
            if warnings:
                for v in warnings[:3]:
                    print(f"    ⚠ [{v.rule}] {v.message}")
            last_violation_count = len(poll_violations)
            if errors:
                reason = f"Context validation error: [{errors[0].rule}] {errors[0].message}"
                return data, approvals_triggered, approvals_resolved, reason

        # Regression tasks can inject genuine USER feedback after the run has
        # produced durable work. Capture the already-generated schema first so
        # evaluation can prove non-goal feedback did not revise it.
        # Three triggers (validated by tree_feedback_routing.validate_mid_run_feedback):
        # a root-message boundary, `when.active_depth_at_least` = N active
        # layers (root + descendants, every agent on the chain STARTING_UP/ACTIVE)
        # read from the per-root tree endpoint on this poll's cadence until fired,
        # or `when.background_task_active` = a running root explore/browser task
        # derived from this poll's root rows (no extra request).
        feedback_config = task.mid_run_feedback or {}
        if feedback_config and not task._mid_run_feedback_posted and status not in TERMINAL_STATUSES:
            feedback_message = feedback_config.get("message")
            initial_schema = agent.get("response_schema")
            trigger_ready = False
            trigger_chain: list[dict] = []
            trigger_tree: list[dict] = []
            trigger_task: Optional[dict] = None
            if trigger_uses_background_task(feedback_config):
                trigger_ready, trigger_task = background_trigger_ready(feedback_config, messages)
            elif trigger_uses_tree(feedback_config):
                try:
                    trigger_agents = await get_agent_tree(base_url, agent_id)
                except httpx.HTTPError as tree_error:
                    print(f"    ⚠ Mid-run feedback tree poll failed; will retry: {tree_error}")
                    trigger_agents = []
                trigger_ready, trigger_chain = tree_trigger_ready(feedback_config, trigger_agents, agent_id)
                if trigger_ready:
                    trigger_tree = tree_snapshot(trigger_agents, agent_id)
            else:
                trigger_ready = root_msg_count >= int(feedback_config.get("after_root_message_count", 1))
            if (
                trigger_ready
                and isinstance(feedback_message, str)
                and feedback_message.strip()
                and isinstance(initial_schema, dict)
                and initial_schema.get("fields")
            ):
                if await post_message(base_url, agent_id, feedback_message):
                    task._mid_run_feedback_initial_schema = json.loads(json.dumps(initial_schema))
                    task._mid_run_feedback_posted = True
                    task._mid_run_feedback_evidence = {
                        "posted": True,
                        "message": feedback_message,
                        "trigger": {k: v for k, v in feedback_config.items() if k != "message"},
                        "posted_after_seconds": round(time.time() - start, 1),
                        "root_message_count": root_msg_count,
                        "active_layers": len(trigger_chain),
                        "active_chain": trigger_chain,
                        "tree_at_trigger": trigger_tree,
                        "background_task": trigger_task,
                    }
                    trigger_detail = (
                        f"running {trigger_task['agent_type']} task {trigger_task['background_task_id']}"
                        if trigger_task
                        else f"{len(trigger_chain)} active layers"
                    )
                    print(
                        "    💬 Injected mid-run feedback after "
                        f"{root_msg_count} root messages ({trigger_detail}); "
                        f"captured {len(initial_schema['fields'])} schema field(s)"
                    )
                else:
                    print("    ⚠ Failed to inject configured mid-run feedback; will retry")

        # Chat mode: done when we have ASSISTANT responses
        if task.is_chat_mode:
            assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
            if len(assistant_msgs) >= 1:
                if status in TERMINAL_STATUSES:
                    return data, approvals_triggered, approvals_resolved, None
                if chat_assistant_seen_at is None:
                    chat_assistant_seen_at = time.monotonic()
                if time.monotonic() - chat_assistant_seen_at >= 10:
                    return data, approvals_triggered, approvals_resolved, None

        if task.success_on_browser_auth_evidence:
            auth_evidence_passed, _ = evaluate_task(task, data, approvals_triggered)
            if auth_evidence_passed:
                print("    ✅ Ordered browser authentication evidence observed")
                return data, approvals_triggered, approvals_resolved, None

        # Agent mode: done on terminal status
        if status in TERMINAL_STATUSES:
            if task.agentcard_setup_action == "complete":
                setup_still_open = False
                if agentcard_setup_attention_seen and agentcard_setup_attention_id:
                    setup_still_open = await _agentcard_setup_attention_still_open_after_terminal(
                        base_url,
                        agentcard_setup_attention_id,
                    )
                data["_benchmark"] = {
                    **data.get("_benchmark", {}),
                    "expected_attention_kinds_seen": list(seen_attention_kinds),
                    "agentcard_setup_attention_seen": agentcard_setup_attention_seen,
                    "agentcard_setup_attention_auto_resolved": (
                        agentcard_setup_attention_seen and not setup_still_open
                    ),
                }
                if not agentcard_setup_attention_seen:
                    return (
                        data,
                        approvals_triggered,
                        approvals_resolved,
                        ("Expected agentcard_user_cardholder_onboarding_required attention request was not observed"),
                    )
                if setup_still_open:
                    return (
                        data,
                        approvals_triggered,
                        approvals_resolved,
                        ("AgentCard setup attention request remained open after agent completion"),
                    )
            return data, approvals_triggered, approvals_resolved, None

        # ── Tree-level stall detection ──────────────────────────────
        # Periodically fetch tree stats (every TREE_POLL_INTERVAL seconds)
        now = time.monotonic()
        live_phone_call = has_in_progress_phone_call(messages)
        if live_phone_call:
            last_activity_time = now
            root_state = per_agent_state.get(agent_id)
            if root_state is None:
                per_agent_state[agent_id] = {"count": root_msg_count, "last_change_time": now, "status": status}
            else:
                root_state["last_change_time"] = now
                root_state["status"] = status
        if now - last_tree_poll >= TREE_POLL_INTERVAL:
            last_tree_poll = now
            tree_stats = await _fetch_tree_stats(base_url, agent_id)
            last_tree_stats = tree_stats

            tree_total_msgs = tree_stats["total_messages"]
            tree_agent_count = tree_stats["agent_count"]
            tree_cost = tree_stats["total_cost_cents"]
            tree_agents = tree_stats.get("all_agents", [])
            active_non_root_ids = [
                a.get("agent_id", "")
                for a in tree_agents
                if a.get("agent_id") and a.get("agent_id") != agent_id and a.get("status") not in TERMINAL_STATUSES
            ]
            detail_message_counts = await _fetch_message_counts(base_url, active_non_root_ids)
            if detail_message_counts:
                tree_total_msgs = root_msg_count
                for a in tree_agents:
                    aid = a.get("agent_id", "")
                    if aid == agent_id:
                        continue
                    tree_total_msgs += detail_message_counts.get(aid, int(a.get("message_count", 0) or 0))

            # Activity check: tree API message_count lags behind reality,
            # so we use MULTIPLE signals: tree message count, root real message count,
            # tree agent count (new agents appearing), and tree cost (LLM calls happening)
            activity_detected = False
            if tree_total_msgs > prev_tree_message_count:
                activity_detected = True
                prev_tree_message_count = tree_total_msgs
            if root_msg_count > prev_root_message_count:
                activity_detected = True
            if tree_agent_count > prev_tree_agent_count:
                activity_detected = True
                prev_tree_agent_count = tree_agent_count
            if tree_cost > prev_tree_cost:
                activity_detected = True
                prev_tree_cost = tree_cost
                last_cost_change_time = now

            if await world_model_operations_in_flight(getattr(task, "_wmh_owned_session", None)):
                activity_detected = True
                last_world_model_activity_time = now

            if activity_detected:
                last_activity_time = now
            prev_root_message_count = root_msg_count

            stall_seconds = now - last_activity_time
            if stall_seconds > STALL_THRESHOLD:
                print(
                    f"    ⚠ TREE STALL: {stall_seconds:.0f}s since last message across "
                    f"{tree_stats['agent_count']} agents ({tree_total_msgs} total msgs)"
                )

            # ── Tree stall detection (early fail) ────────────────────
            # Track each agent's message_count over time. Internal nodes
            # (parents waiting on sub-agents) DO NOT emit messages while
            # their children run — they are correctly idle, not stalled.
            # The work happens at the leaves (agents with no non-terminal
            # children), so the tree is stalled only when EVERY non-terminal
            # leaf has gone silent for AGENT_STALL_SECONDS.
            #
            # For the ROOT agent, the tree API's message_count lags the
            # detail API (in-process browser/claude-code sub-agents emit
            # messages into the root's list but don't increment the tree
            # counter). Use the detail-API root_msg_count for root tracking
            # so legitimate progress isn't flagged as a stall.
            for a in tree_agents:
                aid = a.get("agent_id", "")
                if not aid:
                    continue
                if aid == agent_id:
                    mc = root_msg_count
                else:
                    mc = detail_message_counts.get(aid, int(a.get("message_count", 0) or 0))
                st = a.get("status", "UNKNOWN")
                cur = per_agent_state.get(aid)
                if cur is None:
                    per_agent_state[aid] = {"count": mc, "last_change_time": now, "status": st}
                    continue
                if mc > cur["count"]:
                    cur["count"] = mc
                    cur["last_change_time"] = now
                cur["status"] = st

            # Build parent→children map from the tree.
            children_of: Dict[str, List[str]] = {}
            for a in tree_agents:
                pid = a.get("parent_agent_id")
                cid = a.get("agent_id")
                if pid and cid:
                    children_of.setdefault(pid, []).append(cid)

            # Find non-terminal leaves: an agent is a leaf if no child of
            # it is still active. An agent with all-terminal children counts
            # as a leaf even though it briefly had children.
            leaves: List[str] = []
            for a in tree_agents:
                aid = a.get("agent_id")
                if not aid:
                    continue
                st = per_agent_state.get(aid, {}).get("status", a.get("status", "UNKNOWN"))
                if st in TERMINAL_STATUSES:
                    continue
                child_ids = children_of.get(aid, [])
                has_active_child = any(
                    per_agent_state.get(cid, {}).get("status", "ACTIVE") not in TERMINAL_STATUSES for cid in child_ids
                )
                if not has_active_child:
                    leaves.append(aid)

            # Tree is stalled only when EVERY non-terminal leaf has been
            # silent for ≥ stall_limit_seconds AND tree LLM cost has also
            # stopped growing. Claude Code updates an in-place progress chip
            # without bumping message_count, so cost is the durable signal
            # that a long CC session is still alive.
            if leaves:
                max_leaf_change = max(per_agent_state.get(aid, {}).get("last_change_time", 0.0) for aid in leaves)
                tree_idle = now - max_leaf_change
                cost_idle = now - last_cost_change_time
                world_model_idle = now - last_world_model_activity_time
                if tree_stall_exceeded(
                    tree_idle=tree_idle,
                    cost_idle=cost_idle,
                    world_model_idle=world_model_idle,
                    limit=stall_limit_seconds,
                ):
                    # All leaves silent — pick the staffer leaf (most recent
                    # activity) to surface in the error message.
                    stuck_aid = max(
                        leaves,
                        key=lambda aid: per_agent_state.get(aid, {}).get("last_change_time", 0.0),
                    )
                    stuck_st = per_agent_state.get(stuck_aid, {})
                    role = "root" if stuck_aid == agent_id else "leaf"
                    reason = (
                        f"tree stalled — newest-active {role} {stuck_aid[:12]} "
                        f"silent for {tree_idle:.0f}s (threshold={stall_limit_seconds}s, "
                        f"cost_idle={cost_idle:.0f}s, "
                        f"world_model_idle={world_model_idle:.0f}s, "
                        f"status={stuck_st.get('status', '?')}, "
                        f"messages={stuck_st.get('count', '?')}, "
                        f"non_terminal_leaves={len(leaves)})"
                        f" | Investigate: python agents/benchmarks/agent_latency.py {stuck_aid}"
                        f" | Cache/cost: python agents/benchmarks/run_benchmark.py --compare <run.json>"
                    )
                    print(f"    🛑 TREE STALL — {reason}")
                    return data, approvals_triggered, approvals_resolved, reason

            # Check for infrastructure errors in Fly.io logs
            all_agent_ids = [a.get("agent_id", "") for a in tree_stats.get("all_agents", [])]
            if all_agent_ids:
                infra_errors = _detect_infra_errors_from_fly(all_agent_ids)
                if infra_errors:
                    unique_errors = list(set(infra_errors))[:5]
                    print(f"    🔥 INFRA ERRORS ({len(infra_errors)} total across tree):")
                    for err in unique_errors:
                        print(f"       {err}")

            # Report failed agents
            if tree_stats["failed_count"] > 0:
                for ea in tree_stats["error_agents"][:3]:
                    print(f"    ❌ Agent {ea['agent_id']} → {ea['status']}")
        else:
            # Between tree polls, still track root message activity
            if root_msg_count > prev_root_message_count:
                last_activity_time = now
                prev_root_message_count = root_msg_count

        # Auto-reply to send_message_to_user questions (isWaitingForUser)
        # These block the workflow until a user message is posted back.
        # The flag can be at metadata.isWaitingForUser OR metadata.sendMessageToUser.isWaitingForUser
        for m in messages:
            meta = m.get("metadata", {})
            if not isinstance(meta, dict):
                continue
            msg_id = m.get("message_id") or m.get("id", "")
            is_waiting = meta.get("isWaitingForUser") or (
                isinstance(meta.get("sendMessageToUser"), dict) and meta["sendMessageToUser"].get("isWaitingForUser")
            )
            if is_waiting and msg_id and msg_id not in replied_waiting_msgs:
                replied_waiting_msgs.add(msg_id)
                question = (m.get("text") or m.get("message") or "")[:200]
                print(f"    💬 Agent asked a question: {question}")
                print("    → Auto-replying to unblock workflow")
                try:
                    await post_message(
                        base_url,
                        agent_id,
                        "Please do not ask me anymore questions. I trust your judgment, intuition, "
                        "and ability to make reasonable assumptions. Please proceed with the task. "
                        "All files have been uploaded as attachments and should be available in your context.",
                    )
                except Exception as e:
                    print(f"    ⚠ Auto-reply failed: {e}")

        # Handle approval requests (check entire agent tree, not just root)
        tree_agent_ids = {agent_id}  # always include root
        if last_tree_stats.get("all_agents"):
            tree_agent_ids.update(a.get("agent_id", "") for a in last_tree_stats["all_agents"] if a.get("agent_id"))
        if fetch_approvals_now:
            try:
                pending = _pending_attention
                if task.expected_attention_kind_any_of:
                    unseen_open = [
                        req
                        for req in pending
                        if (req.get("agentId") or req.get("agent_id", "")) in tree_agent_ids
                        and _attention_request_is_open(req)
                        and req.get("id")
                        and req.get("id") not in seen_attention_ids
                    ]
                    if len(unseen_open) > 1:
                        observed = [*seen_attention_kinds, *(_attention_request_kind(req) for req in unseen_open)]
                        data["_benchmark"] = {
                            **data.get("_benchmark", {}),
                            "expected_attention_kind_any_of": list(task.expected_attention_kind_any_of),
                            "attention_kinds_observed": observed,
                        }
                        return (
                            data,
                            approvals_triggered,
                            approvals_resolved,
                            f"Expected exactly one attention request of kind one of "
                            f"{task.expected_attention_kind_any_of}, observed {observed}",
                        )
                for req in pending:
                    req_agent_id = req.get("agentId") or req.get("agent_id", "")
                    if req_agent_id in tree_agent_ids and _attention_request_is_open(req):
                        req_id = req.get("id")
                        if req_id and req_id not in seen_attention_ids:
                            seen_attention_ids.add(req_id)
                            expected_kind = _expected_attention_kind(task, approvals_triggered)
                            if not _attention_request_matches_task(task, req, approvals_triggered):
                                observed_kind = _attention_request_kind(req)
                                if (
                                    task.expected_gate
                                    and not task.require_attention_order
                                    and task.approval_handling == "auto_approve"
                                    and observed_kind == "payment_approval"
                                ):
                                    await respond_to_attention_request(base_url, req_id, "approved")
                                    approvals_resolved += 1
                                    print(f"    ✅ Auto-approved payment-card prerequisite {req_id[:8]}")
                                    continue
                                # Place-order / purchase write locks can fire before the
                                # payment-card mint (task prompts often say "click Place
                                # order, then pay"). When the harness is waiting for
                                # payment_approval under auto_approve, clear the write
                                # lock and keep polling for the card request — do not
                                # treat the write lock as the expected attention kind.
                                if (
                                    task.approval_handling == "auto_approve"
                                    and observed_kind == "write_lock"
                                    and expected_kind == "payment_approval"
                                ):
                                    await respond_to_attention_request(base_url, req_id, "approved")
                                    approvals_resolved += 1
                                    write_lock_prerequisite_request_id = req_id
                                    data["_benchmark"] = {
                                        **data.get("_benchmark", {}),
                                        "write_lock_prerequisite_auto_approved": True,
                                        "write_lock_prerequisite_request_id": req_id,
                                    }
                                    print(f"    ✅ Auto-approved write-lock prerequisite {req_id[:8]}")
                                    continue
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "unexpected_attention_kind": observed_kind,
                                    "expected_attention_kind": expected_kind,
                                    "unexpected_attention_request_id": req_id,
                                }
                                if task.expected_attention_kind_any_of:
                                    observed = [*seen_attention_kinds, observed_kind]
                                    data["_benchmark"]["expected_attention_kind_any_of"] = list(
                                        task.expected_attention_kind_any_of
                                    )
                                    data["_benchmark"]["attention_kinds_observed"] = observed
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        f"Expected exactly one attention request of kind one of "
                                        f"{task.expected_attention_kind_any_of}, observed {observed}",
                                    )
                                if task.expected_gate:
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        f"Expected gate {task.expected_gate}, observed {observed_kind}",
                                    )
                                return (
                                    data,
                                    approvals_triggered,
                                    approvals_resolved,
                                    f"Expected attention kind {expected_kind}, observed {observed_kind}",
                                )
                            approvals_triggered += 1
                            observed_kind = _attention_request_kind(req)
                            seen_attention_kinds.append(observed_kind)
                            attention_requests_seen.append(_attention_request_evidence(req))
                            data["_benchmark"] = {
                                **data.get("_benchmark", {}),
                                "attention_request_kind_seen": observed_kind,
                                "attention_request_id": req_id,
                                "approvals_triggered": approvals_triggered,
                                "attention_requests_seen": list(attention_requests_seen),
                            }
                            if task.expected_attention_kind:
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_attention_kind_seen": task.expected_attention_kind,
                                    "expected_attention_request_id": req_id,
                                }
                            if task.expected_attention_kind_any_of:
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_attention_kind_seen": observed_kind,
                                    "expected_attention_kind_any_of": list(task.expected_attention_kind_any_of),
                                    "expected_attention_request_id": req_id,
                                }
                            if task.expected_attention_kinds:
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_attention_kinds_seen": list(seen_attention_kinds),
                                }
                            if task.complete_subscription_checkout and observed_kind == "gate:subscription":
                                gate = (req.get("metadata") or {}).get("gate") or {}
                                checkout_url = (gate.get("action") or {}).get("url")
                                if not isinstance(checkout_url, str):
                                    raise RuntimeError("Subscription gate has no Checkout URL")
                                expected_gate_evidence = {"gate": gate, "request_id": req_id}
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_gate_seen": True,
                                    "expected_gate": gate,
                                    "expected_gate_request_id": req_id,
                                }
                                print(f"    💳 Completing hosted Stripe Checkout for gate {req_id[:8]}")
                                try:
                                    checkout = await complete_test_subscription_checkout(
                                        base_url,
                                        checkout_url,
                                        _current_benchmark_user_id(),
                                        stripe_key=load_env_var("STRIPE_SECRET_KEY", _AGENTS_ENV, _BACKEND_ENV),
                                        webhook_secret=load_env_var("STRIPE_WEBHOOK_SECRET", _AGENTS_ENV, _BACKEND_ENV),
                                    )
                                except Exception as checkout_error:
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        f"Subscription Checkout failed: {checkout_error}",
                                    )
                                subscription_checkout_evidence = checkout
                                data["_benchmark"]["subscription_checkout"] = checkout
                                print(f"    ✅ Completed paid Stripe test Checkout {checkout['session_id'][:18]}")
                                continue
                            if task.expected_gate and _gate_request_matches_task(task, req):
                                expected_gate_evidence = {
                                    "gate": (req.get("metadata") or {}).get("gate"),
                                    "request_id": req_id,
                                }
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_gate_seen": True,
                                    "expected_gate": expected_gate_evidence["gate"],
                                    "expected_gate_request_id": req_id,
                                }
                                if task.simulate_gate_webhook == "subscription":
                                    await _simulate_subscription_checkout_webhook(
                                        base_url,
                                        _current_benchmark_user_id(),
                                    )
                                    data["_benchmark"] = {
                                        **data.get("_benchmark", {}),
                                        "subscription_webhook_simulated": True,
                                    }
                                    print(f"    ✅ Simulated subscription webhook after gate {req_id[:8]}")
                                    continue
                                print(f"    ✅ Expected gate observed {req_id[:8]}")
                                return data, approvals_triggered, approvals_resolved, None
                            if observed_kind == "payment_approval":
                                receipt_error = _validate_payment_receipt(task, req, messages=messages)
                                if receipt_error:
                                    data["_benchmark"] = {
                                        **data.get("_benchmark", {}),
                                        "payment_receipt_validation_error": receipt_error,
                                        "payment_receipt_request_id": req_id,
                                    }
                                    return data, approvals_triggered, approvals_resolved, receipt_error
                                if task.expected_payment_receipt:
                                    validated_payment_receipt_request_id = req_id
                                    data["_benchmark"] = {
                                        **data.get("_benchmark", {}),
                                        "expected_payment_receipt_seen": True,
                                        "expected_payment_receipt_request_id": req_id,
                                    }
                            if task.success_on_payment_card_request and task.payment_card_request_action is None:
                                if task.approval_handling == "count_only":
                                    await respond_to_attention_request(base_url, req_id, _count_only_release_response())
                                    approvals_resolved += 1
                                    print(f"    ✅ Counted and released payment-card request {req_id[:8]}")
                                elif task.approval_handling == "prompt_user" and not sys.stdin.isatty():
                                    print(
                                        f"    ⚠ Non-interactive environment — auto-denying payment-card request {req_id[:8]}"
                                    )
                                    await respond_to_attention_request(base_url, req_id, _approval_rejection_response())
                                print(f"    ✅ Payment-card request observed {req_id[:8]}")
                                return data, approvals_triggered, approvals_resolved, None
                            if task.approval_handling == "count_only":
                                await respond_to_attention_request(base_url, req_id, _count_only_release_response())
                                approvals_resolved += 1
                                print(f"    ✅ Counted and released approval request {req_id[:8]}")
                            user_response = (
                                (auth_test_site.declared_block(task.environment) or {}).get("user_response")
                                if observed_kind == "auth_assistance"
                                else None
                            )
                            if user_response:
                                try:
                                    await _respond_as_user_to_auth_assistance(base_url, agent_id, req, user_response)
                                except Exception as user_error:
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        f"Stand-in user could not {user_response}: {user_error}",
                                    )
                                approvals_resolved += 1
                                continue
                            if task.approval_handling == "ignore":
                                if measurement_required(task) and not parked_page_observation(
                                        data, auth_test_site.active_manifest(), _current_benchmark_user_id()):
                                    continue  # Attention publication precedes the native parked receipt.
                                kind_label = (
                                    f" ({observed_kind})"
                                    if (
                                        task.expected_attention_kind
                                        or task.expected_attention_kinds
                                        or task.expected_attention_kind_any_of
                                    )
                                    else ""
                                )
                                print(f"    ✅ Approval request observed{kind_label} {req_id[:8]}")
                                return data, approvals_triggered, approvals_resolved, None
                            if (
                                task.agentcard_setup_action == "complete"
                                and observed_kind == "agentcard_user_cardholder_onboarding_required"
                            ):
                                try:
                                    await configure_benchmark_agentcard_setup(base_url, "complete")
                                except RuntimeError as setup_error:
                                    # The attention is already marked seen; swallowing this
                                    # leaves the agent waiting on setup until the task timeout.
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        f"AgentCard setup fixture failed: {setup_error}",
                                    )
                                agentcard_setup_attention_seen = True
                                agentcard_setup_attention_id = req_id
                                print(f"    ✅ Completed one-time AgentCard setup for attention {req_id[:8]}")
                                continue
                        if task.name == CALENDLY_TASK_NAME and _contains_calendly_link(req):
                            data["_benchmark"] = {"calendly_link_approval_seen": True}
                            print("    ✅ Calendly link approval request observed")
                            return data, approvals_triggered, approvals_resolved, None
                        if (
                            task.approval_handling == "count_only"
                            and task.expected_approval_count is not None
                            and approvals_triggered >= task.expected_approval_count
                        ):
                            data["_benchmark"] = {"expected_approval_count_seen": approvals_triggered}
                            print(
                                f"    ✅ Expected approval count observed "
                                f"({approvals_triggered}/{task.expected_approval_count})"
                            )
                            return data, approvals_triggered, approvals_resolved, None
                        if task.approval_handling == "auto_approve" and _should_auto_approve_attention(task, req):
                            if req_id:
                                if not _phone_approval_matches_callee(task, req):
                                    await respond_to_attention_request(base_url, req_id, "denied")
                                    return (
                                        data,
                                        approvals_triggered,
                                        approvals_resolved,
                                        "Refused to auto-approve phone call to non-benchmark number",
                                    )
                                await respond_to_attention_request(base_url, req_id, "approved")
                                approvals_resolved += 1
                                print(f"    ✅ Auto-approved attention request {req_id[:8]}")
                        elif task.complete_subscription_checkout and observed_kind == "gate:subscription":
                            return (
                                data,
                                approvals_triggered,
                                approvals_resolved,
                                "Subscription gate reached generic approval handler",
                            )
                        elif task.approval_handling == "prompt_user":
                            if req_id:
                                question = req.get("question", req.get("message", "(no details)"))
                                print(f"\n    🔔 APPROVAL REQUIRED: {question[:200]}")
                                if not sys.stdin.isatty():
                                    print(f"    ⚠ Non-interactive environment — auto-denying {req_id[:8]}")
                                    await respond_to_attention_request(base_url, req_id, _approval_rejection_response())
                                    continue
                                loop = asyncio.get_event_loop()
                                answer = (
                                    (await loop.run_in_executor(None, input, "    Approve? [y/n]: ")).strip().lower()
                                )
                                if answer in ("y", "yes"):
                                    await respond_to_attention_request(base_url, req_id, "approved")
                                    approvals_resolved += 1
                                    print(f"    ✅ User approved {req_id[:8]}")
                                else:
                                    await respond_to_attention_request(base_url, req_id, _approval_rejection_response())
                                    print(f"    ❌ User denied {req_id[:8]}")
            except Exception as e:
                print(f"    ⚠ Approval check error: {e}")

        # Progress log — show tree-level stats every 30s
        if now - last_progress_print >= 30:
            last_progress_print = now
            ts = last_tree_stats
            if ts:
                tree_cost = ts.get("total_cost_cents", 0)
                tree_agents = ts.get("agent_count", 0)
                tree_active = ts.get("active_count", 0)
                tree_failed = ts.get("failed_count", 0)
                print(
                    f"    ... {status} | {tree_agents} agents ({tree_active} active, {tree_failed} failed) | "
                    f"{root_msg_count} root msgs | {tree_cost}c | {elapsed:.0f}s"
                )
            else:
                print(f"    ... {status} ({root_msg_count} root msgs, {elapsed:.0f}s)")

        await asyncio.sleep(POLL_INTERVAL)


# ============================================================
# Evaluation
# ============================================================


def _validate_mid_run_feedback_schema(task: BenchmarkTask, data: dict) -> Optional[str]:
    """Require non-goal mid-run feedback to leave the response schema untouched.

    Only feedback declared ``non_goal: true`` pins the schema; goal-changing
    feedback may legitimately refresh it.
    """
    if not task.mid_run_feedback or not task.mid_run_feedback.get("non_goal"):
        return None
    if not getattr(task, "_mid_run_feedback_posted", False):
        return "Configured mid-run feedback was never posted"

    initial_schema = getattr(task, "_mid_run_feedback_initial_schema", None)
    final_schema = (data.get("agent") or {}).get("response_schema")
    if initial_schema != final_schema:
        return (
            "Response schema changed after non-goal feedback: "
            f"initial={json.dumps(initial_schema, sort_keys=True)} "
            f"final={json.dumps(final_schema, sort_keys=True)}"
        )

    schema_update_messages = [
        message
        for message in data.get("messages", []) or []
        if isinstance(message.get("metadata"), dict) and message["metadata"].get("isResponseSchemaUpdate") is True
    ]
    if schema_update_messages:
        return f"Non-goal feedback created {len(schema_update_messages)} hidden response-schema update message(s)"
    return None


def evaluate_task(
    task: BenchmarkTask,
    data: dict,
    approvals_triggered: int,
) -> Tuple[bool, Optional[str]]:
    """
    Evaluate whether a task passed based on agent data.
    Returns: (passed, failure_reason)
    """
    agent = data.get("agent", {})
    status = agent.get("status", "UNKNOWN")
    messages = data.get("messages", [])
    progress = agent.get("progress", 0)

    observed_providers: set[str] = set()
    credential_ref_kinds: set[str] = set()
    provider_scopes: dict[str, set[str]] = {}
    credential_scopes: dict[str, set[str]] = {}
    browser_session_metadata_by_scope: dict[str, list[tuple[int, dict]]] = {}
    credential_indexes_by_scope_kind: dict[tuple[str, str], list[int]] = {}
    message_evidence_by_scope: dict[str, list[tuple[int, str]]] = {}
    structured_responses: list[tuple[str, dict]] = []
    tool_call_scopes: dict[str, set[str]] = {}
    for message in messages:
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        auxiliary = metadata.get("auxiliary")
        scope_value = metadata.get("subAgentId") or metadata.get("task_id")
        if not scope_value and isinstance(auxiliary, dict):
            scope_value = auxiliary.get("subAgentId") or auxiliary.get("task_id")
        if not scope_value:
            continue
        for candidate in (metadata, auxiliary):
            if not isinstance(candidate, dict):
                continue
            tool_call_id = candidate.get("toolCallId") or candidate.get("tool_call_id")
            if tool_call_id:
                tool_call_scopes.setdefault(str(tool_call_id), set()).add(str(scope_value))

    for message_index, message in enumerate(messages):
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        auxiliary = metadata.get("auxiliary")
        scope_value = metadata.get("subAgentId") or metadata.get("task_id")
        if not scope_value and isinstance(auxiliary, dict):
            scope_value = auxiliary.get("subAgentId") or auxiliary.get("task_id")
        if not scope_value:
            tool_call_id = metadata.get("toolCallId") or metadata.get("tool_call_id")
            linked_scopes = tool_call_scopes.get(str(tool_call_id), set()) if tool_call_id else set()
            if len(linked_scopes) == 1:
                scope_value = next(iter(linked_scopes))
        task_scope = str(scope_value) if scope_value else f"message:{message_index}"
        candidates = [metadata]
        if isinstance(auxiliary, dict):
            candidates.append(auxiliary)
        browser_session_value = next(
            (
                candidate.get("browser_session_id") or candidate.get("browser_url")
                for candidate in candidates
                if candidate.get("browser_session_id") or candidate.get("browser_url")
            ),
            None,
        )
        scope = f"{task_scope}|browser_session:{browser_session_value}" if browser_session_value else task_scope

        # Only completed browser actions are grounded page evidence. Task
        # prompts, verifier prose, and assistant restatements can contain the
        # expected text without proving it was ever visible in the browser.
        action_type = next(
            (candidate.get("action_type") for candidate in candidates if candidate.get("action_type")),
            None,
        )
        tool_status = next(
            (candidate.get("toolStatus") for candidate in candidates if candidate.get("toolStatus")),
            None,
        )
        # This auth probe's greeting markers must come from a DOM element the
        # browser actually clicked. Input/select titles include model-supplied
        # values and could otherwise manufacture the expected greeting text.
        grounded_action_types = {"click"}
        if message.get("role") == "TOOL" and tool_status == "FINISHED" and action_type in grounded_action_types:
            evidence = "\n".join(
                candidate["title"] for candidate in candidates if isinstance(candidate.get("title"), str)
            )
            if evidence:
                message_evidence_by_scope.setdefault(scope, []).append((message_index, evidence))
        for candidate in candidates:
            session_metadata = candidate.get("browser_session_metadata")
            if isinstance(session_metadata, dict):
                browser_session_metadata_by_scope.setdefault(scope, []).append((message_index, session_metadata))
                if isinstance(session_metadata.get("provider"), str):
                    provider = session_metadata["provider"]
                    observed_providers.add(provider)
                    provider_scopes.setdefault(provider, set()).add(scope)
            credential_ref = candidate.get("credential_ref") or candidate.get("credentialRef")
            # USER OTP availability messages mean a code was fetched, not
            # exercised. TOOL credential refs are the durable usage signal.
            if (
                message.get("role") == "TOOL"
                and isinstance(credential_ref, dict)
                and isinstance(credential_ref.get("kind"), str)
            ):
                kind = credential_ref["kind"]
                credential_ref_kinds.add(kind)
                credential_scopes.setdefault(kind, set()).add(scope)
                credential_indexes_by_scope_kind.setdefault((scope, kind), []).append(message_index)
            structured_response = candidate.get("structured_response") or candidate.get("structuredResponse")
            if isinstance(structured_response, dict):
                structured_responses.append((scope, structured_response))

    if task.expected_credential_ref_kind:
        expected_kind = task.expected_credential_ref_kind
        if expected_kind not in credential_ref_kinds:
            return False, f"Expected credential_ref kind {expected_kind} but none was observed"

    forbidden_kinds = set(task.forbidden_credential_ref_kinds)
    observed_forbidden_kinds = forbidden_kinds & credential_ref_kinds
    if observed_forbidden_kinds:
        observed = ", ".join(sorted(observed_forbidden_kinds))
        return False, f"Observed forbidden credential_ref kind(s): {observed}"

    if task.expected_browser_provider:
        expected_provider = task.expected_browser_provider
        if expected_provider not in observed_providers:
            observed = ", ".join(sorted(observed_providers)) or "none"
            return False, f"Expected browser provider {expected_provider} but observed: {observed}"
        if task.expected_credential_ref_kind:
            provider_task_scopes = provider_scopes.get(expected_provider, set())
            credential_task_scopes = credential_scopes.get(task.expected_credential_ref_kind, set())
            if not provider_task_scopes.intersection(credential_task_scopes):
                return (
                    False,
                    f"Expected browser provider {expected_provider} and credential_ref kind "
                    f"{task.expected_credential_ref_kind} on the same browser session",
                )

    matching_session_metadata_scopes: set[str] = set()
    matching_session_metadata_indexes: dict[str, list[int]] = {}
    if task.expected_browser_session_metadata_values:
        expected_metadata = task.expected_browser_session_metadata_values
        for scope, metadata_items in browser_session_metadata_by_scope.items():
            first_credential_index = min(
                credential_indexes_by_scope_kind.get(
                    (scope, task.expected_credential_ref_kind or ""),
                    [len(messages)],
                )
            )
            matching_indexes = [
                message_index
                for message_index, metadata_item in metadata_items
                if message_index < first_credential_index
                and all(metadata_item.get(key) == value for key, value in expected_metadata.items())
            ]
            if matching_indexes:
                matching_session_metadata_scopes.add(scope)
                matching_session_metadata_indexes[scope] = matching_indexes
        if not matching_session_metadata_scopes:
            return False, "Expected isolated browser session metadata was not observed"

    matching_pre_credential_scopes: set[str] = set()
    if task.expected_pre_credential_message_contains:
        expected_kind = task.expected_credential_ref_kind
        if not expected_kind:
            return False, "Pre-credential evidence requires expected_credential_ref_kind"
        for scope in credential_scopes.get(expected_kind, set()):
            first_credential_index = min(credential_indexes_by_scope_kind.get((scope, expected_kind), [len(messages)]))
            session_metadata_index = min(matching_session_metadata_indexes.get(scope, [-1]))
            prior_evidence = "\n".join(
                evidence
                for message_index, evidence in message_evidence_by_scope.get(scope, [])
                if session_metadata_index < message_index < first_credential_index
            ).lower()
            if all(needle.lower() in prior_evidence for needle in task.expected_pre_credential_message_contains):
                matching_pre_credential_scopes.add(scope)
        if not matching_pre_credential_scopes:
            return False, "Expected signed-out evidence before passkey use was not observed"

    matching_post_credential_scopes: set[str] = set()
    if task.expected_post_credential_message_contains:
        expected_kind = task.expected_credential_ref_kind
        if not expected_kind:
            return False, "Post-credential evidence requires expected_credential_ref_kind"
        for scope in credential_scopes.get(expected_kind, set()):
            first_credential_index = min(credential_indexes_by_scope_kind.get((scope, expected_kind), [len(messages)]))
            later_evidence = "\n".join(
                evidence
                for message_index, evidence in message_evidence_by_scope.get(scope, [])
                if message_index > first_credential_index
            ).lower()
            if all(needle.lower() in later_evidence for needle in task.expected_post_credential_message_contains):
                matching_post_credential_scopes.add(scope)
        if not matching_post_credential_scopes:
            return False, "Expected authenticated page evidence after passkey use was not observed"

    has_structured_response_requirements = bool(
        task.expected_structured_response_values
        or task.expected_structured_response_contains
        or task.required_structured_response_fields
    )
    matching_structured_scopes: set[str] = set()
    if has_structured_response_requirements:
        expected_values = task.expected_structured_response_values or {}
        expected_contains = task.expected_structured_response_contains or {}

        def _structured_response_matches(response: dict) -> bool:
            if not all(response.get(key) == expected for key, expected in expected_values.items()):
                return False
            for key, raw_needles in expected_contains.items():
                value = response.get(key)
                needles = [raw_needles] if isinstance(raw_needles, str) else raw_needles
                if not isinstance(value, str) or not isinstance(needles, list):
                    return False
                if not all(isinstance(needle, str) and needle.lower() in value.lower() for needle in needles):
                    return False
            return all(response.get(key) not in (None, "", [], {}) for key in task.required_structured_response_fields)

        matching_structured_scopes = {
            scope for scope, response in structured_responses if _structured_response_matches(response)
        }
        if not matching_structured_scopes:
            return False, "Expected authenticated structured browser response evidence was not observed"

    if task.expected_browser_provider and task.expected_credential_ref_kind:
        provider_task_scopes = provider_scopes.get(task.expected_browser_provider, set())
        credential_task_scopes = credential_scopes.get(task.expected_credential_ref_kind, set())
        correlated_scopes = provider_task_scopes.intersection(credential_task_scopes)
        if task.expected_browser_session_metadata_values:
            correlated_scopes.intersection_update(matching_session_metadata_scopes)
        if task.expected_pre_credential_message_contains:
            correlated_scopes.intersection_update(matching_pre_credential_scopes)
        if task.expected_post_credential_message_contains:
            correlated_scopes.intersection_update(matching_post_credential_scopes)
        if has_structured_response_requirements:
            correlated_scopes.intersection_update(matching_structured_scopes)
        if not correlated_scopes:
            if has_structured_response_requirements:
                return (
                    False,
                    "Expected provider, credential, and authenticated response evidence on the same browser session",
                )
            return False, "Expected provider, credential, and authenticated page evidence on the same browser session"

    if task.success_on_browser_auth_evidence:
        return True, None

    # Chat mode: just needs ASSISTANT response
    if task.is_chat_mode:
        assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
        if len(assistant_msgs) == 0:
            return False, "No assistant response received"
        return True, None

    # Ignore-mode: agent will stall waiting for approval — we only check
    # that the approval was actually triggered (the agent won't complete).
    if task.approval_handling == "ignore":
        if approvals_triggered == 0:
            if task.expected_attention_kind_any_of:
                return (
                    False,
                    f"Expected one of {task.expected_attention_kind_any_of} attention requests "
                    f"(to ignore) but none was triggered",
                )
            if task.expected_attention_kinds:
                return (
                    False,
                    f"Expected one of {task.expected_attention_kinds} attention requests (to ignore) but none was triggered",
                )
            if task.expected_attention_kind:
                return (
                    False,
                    f"Expected {task.expected_attention_kind} attention request (to ignore) but none was triggered",
                )
            return False, "Expected approval request (to ignore) but none were triggered"
        benchmark_state = data.get("_benchmark", {})
        observed_kind = benchmark_state.get("attention_request_kind_seen")
        if task.expected_attention_kind_any_of:
            if observed_kind not in task.expected_attention_kind_any_of:
                return (
                    False,
                    f"Expected one of {task.expected_attention_kind_any_of} attention requests, "
                    f"observed {observed_kind}",
                )
        if task.expected_attention_kind:
            if benchmark_state.get("expected_attention_kind_seen") != task.expected_attention_kind:
                return False, f"Expected {task.expected_attention_kind} attention request but it was not observed"
        if task.expected_attention_kinds:
            if observed_kind not in task.expected_attention_kinds:
                return (
                    False,
                    f"Expected one of {task.expected_attention_kinds} attention requests, observed {observed_kind}",
                )
        if task.expected_payment_receipt and observed_kind == "payment_approval":
            if benchmark_state.get("expected_payment_receipt_seen") is not True:
                return False, "Expected validated payment-card request but none was observed"
        return True, None

    if task.name == CALENDLY_TASK_NAME:
        benchmark_state = data.get("_benchmark", {})
        if benchmark_state.get("calendly_link_approval_seen"):
            return True, None

    if task.approval_handling == "count_only":
        expected = task.expected_approval_count
        if expected is None:
            return False, "count_only task missing expected_approval_count"
        benchmark_state = data.get("_benchmark", {})
        observed = benchmark_state.get("expected_approval_count_seen", approvals_triggered)
        if observed >= expected:
            return True, None
        return False, f"Expected {expected} approval requests, observed {observed}"

    if task.success_on_plan:
        plan = data.get("_benchmark", {}).get("plan") or find_accepted_plan(data.get("messages") or [])
        if plan:
            data.setdefault("_benchmark", {})["plan"] = plan
            return True, None
        return False, "Expected an accepted plan (plan-only task) but none was observed"

    if task.success_on_payment_card_request:
        benchmark_state = data.get("_benchmark", {})
        if benchmark_state.get("expected_payment_receipt_seen"):
            lifecycle_error = _validate_payment_lifecycle(task, data)
            if lifecycle_error:
                return False, lifecycle_error
            return True, None
        return False, "Expected validated payment-card request but none was observed"

    if task.expected_gate and not task.simulate_gate_webhook and not task.complete_subscription_checkout:
        if _mark_expected_gate_from_data(task, data):
            return True, None
        return False, f"Expected gate {task.expected_gate} but none was observed"

    if task.simulate_gate_webhook:
        _mark_expected_gate_from_data(task, data)
        benchmark_state = data.get("_benchmark", {})
        if benchmark_state.get("expected_gate_seen") is not True:
            return False, f"Expected gate {task.expected_gate} before webhook resume"
        if benchmark_state.get("subscription_webhook_simulated") is not True:
            return False, "Expected simulated subscription webhook after gate"

    if task.complete_subscription_checkout:
        benchmark_state = data.get("_benchmark", {})
        checkout = benchmark_state.get("subscription_checkout") or {}
        if benchmark_state.get("expected_gate_seen") is not True:
            return False, "Expected subscription gate before Checkout"
        if (
            checkout.get("status") != "complete"
            or checkout.get("payment_status") != "paid"
            or checkout.get("webhook_delivered") is not True
        ):
            return False, "Expected paid Stripe test Checkout and local webhook delivery"

    if task.require_attention_order:
        observed = (data.get("_benchmark") or {}).get("expected_attention_kinds_seen")
        if observed != task.expected_attention_kinds:
            return False, f"Attention sequence mismatch: expected {task.expected_attention_kinds}, got {observed}"

    # Agent mode: must complete. Polar step-budget stops pause the agent on
    # purpose so the Odysseys/BU judge can grade the trajectory (upstream also
    # stops on max steps, then rubrics — not a wall-clock fail).
    if status != "COMPLETED":
        benchmark_state = data.get("_benchmark", {}) if isinstance(data, dict) else {}
        if status == "PAUSED" and benchmark_state.get("step_budget_reached") is True and is_polar_bench_task(task):
            pass
        else:
            return False, f"Agent status: {status} (expected COMPLETED)"

    if task.agentcard_setup_action == "complete":
        benchmark_state = data.get("_benchmark", {})
        if benchmark_state.get("expected_attention_kinds_seen") != task.expected_attention_kinds:
            return False, (
                "AgentCard setup attention sequence mismatch: "
                f"expected {task.expected_attention_kinds}, got "
                f"{benchmark_state.get('expected_attention_kinds_seen')}"
            )
        if benchmark_state.get("agentcard_setup_attention_auto_resolved") is not True:
            return False, "AgentCard setup attention did not auto-resolve"

    mid_run_schema_failure = _validate_mid_run_feedback_schema(task, data)
    if mid_run_schema_failure:
        return False, mid_run_schema_failure

    # Check expected tools were called
    all_metadata = " ".join(json.dumps(m.get("metadata", {})) for m in messages if m.get("metadata")).lower()

    for tool in task.expected_tools:
        if tool.lower() not in all_metadata:
            return False, f"Expected tool '{tool}' not found in messages"

    if task.name == "message-person":
        delivery_error = _validate_message_person_confirmed_send(data)
        if delivery_error:
            return False, delivery_error

    if task.name == MESSAGE_PERSON_AGENT_SMS_TASK_NAME:
        delivery_error = _validate_message_person_agent_sms_send(data)
        if delivery_error:
            return False, delivery_error

    if task.name == BIOMETRICS_WEBDECOY_TASK_NAME:
        passed, reason = _evaluate_webdecoy_biometrics_result(data)
        if not passed:
            return False, reason

    # agent-payment-test-shop's grounded-confirmation-id check is a semantic gate run in the async
    # post-eval pass (validate_agent_payment_confirmation_contract) so the browser agent's
    # LLM-synthesized output schema is judged by MEANING, not an exact key name.
    if task.expected_payment_lifecycle:
        lifecycle_error = _validate_payment_lifecycle(task, data)
        if lifecycle_error:
            return False, lifecycle_error
    if task.name == GREP_EXPLORE_STRESS_TASK_NAME:
        return True, None

    # Check approval expectations.
    if task.approval_handling in ("auto_approve", "prompt_user") and approvals_triggered == 0:
        return False, "Expected approval requests but none were triggered"

    if task.expected_attention_kind_any_of and approvals_triggered > 0:
        observed_kind = data.get("_benchmark", {}).get("attention_request_kind_seen")
        if observed_kind not in task.expected_attention_kind_any_of:
            return (
                False,
                f"Expected exactly one attention request of kind one of "
                f"{task.expected_attention_kind_any_of}, observed {observed_kind}",
            )

    if (
        task.approval_handling != "count_only"
        and task.expected_approval_count is not None
        and approvals_triggered != task.expected_approval_count
    ):
        return (
            False,
            f"Expected exactly {task.expected_approval_count} approval request(s), observed {approvals_triggered}",
        )

    # Progress score check (verifier gave a score)
    if progress < 0.5:
        return False, f"Low progress score: {progress:.2f}"

    return True, None


def _validate_message_person_confirmed_send(data: dict) -> Optional[str]:
    """Require the Mac sender's durable acknowledgement, not merely enqueue."""
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "message_person" or metadata.get("toolStatus") != "FINISHED":
            continue
        event_data = metadata.get("data")
        if not isinstance(event_data, dict):
            continue
        delivery = event_data.get("delivery")
        if not isinstance(delivery, dict):
            continue
        if (
            delivery.get("channel") == "imessage"
            and delivery.get("status") == "sent"
            and isinstance(delivery.get("queue_id"), str)
            and isinstance(delivery.get("sent_at"), str)
        ):
            if delivery["queue_id"] and delivery["sent_at"]:
                return None
    return "message_person did not produce a confirmed Mac iMessage send acknowledgement"


def _validate_message_person_agent_sms_send(data: dict) -> Optional[str]:
    """Require an immediate AgentPhone receipt, never an iMessage queue receipt."""
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "message_person" or metadata.get("toolStatus") != "FINISHED":
            continue
        event_data = metadata.get("data")
        if not isinstance(event_data, dict):
            continue
        delivery = event_data.get("delivery")
        if not isinstance(delivery, dict):
            continue
        if (
            delivery.get("channel") == "agent_sms"
            and delivery.get("status") == "sent"
            and delivery.get("provider") == "agentphone"
            and isinstance(delivery.get("provider_channel"), str)
            and isinstance(delivery.get("message_id"), str)
            and not delivery.get("queue_id")
        ):
            if delivery["provider_channel"] and delivery["message_id"]:
                return None
    return "message_person did not produce an immediate AgentPhone send receipt"


def evaluate_force_show_passwords_auth_task(
    task: BenchmarkTask,
    data: dict,
    approvals_triggered: int,
    approvals_resolved: int,
) -> Tuple[bool, Optional[str]]:
    """Validate the bad-auth lifecycle for Amazon --anon --force-show-passwords."""
    if task.name != AMAZON_AUTH_ASSISTANCE_TASK_NAME or not _force_show_passwords_mode():
        return True, None
    agent = data.get("agent", {})
    status = agent.get("status", "UNKNOWN")
    status_message = agent.get("status_message") or agent.get("statusMessage") or ""
    if approvals_triggered <= 0:
        return False, "expected request_user_assistance_for_authentication attention request"
    if approvals_resolved <= 0:
        return False, "expected auth assistance request to be auto-approved/resolved"
    if status != "FAILED":
        return False, f"expected agent to fail after empty auth assistance approval, got {status}"
    if "max" not in str(status_message).lower() and "iteration" not in str(status_message).lower():
        return False, f"expected max-turn/max-iteration failure after resume, got: {status_message or '(empty)'}"
    rows_ok, rows_reason = _validate_bad_amazon_auth_scenario(USER_ID)
    if not rows_ok:
        return False, rows_reason
    return True, None


def _approval_mode_allows_open_tool_context(
    task: BenchmarkTask,
    data: dict,
    approvals_triggered: int,
) -> bool:
    """Return true when a benchmark intentionally stops while approval blocks a tool."""
    if task.approval_handling == "ignore" and approvals_triggered > 0:
        return True
    if task.approval_handling != "count_only" or task.expected_approval_count is None:
        return False
    benchmark_state = data.get("_benchmark", {})
    observed = benchmark_state.get("expected_approval_count_seen", approvals_triggered)
    return observed >= task.expected_approval_count


def _final_context_violations_for_result(
    task: BenchmarkTask,
    data: dict,
    approvals_triggered: int,
    violations: list,
) -> list:
    """Drop expected open-tool pairing violations when approval intentionally blocks completion."""
    if not _approval_mode_allows_open_tool_context(task, data, approvals_triggered):
        return violations
    return [v for v in violations if getattr(v, "rule", None) != "tool_result_pairing"]


# ============================================================
# CSV row slicing
# ============================================================


def _resolve_task_attachment_path(attach_filename: str, cleanup_paths: list) -> str:
    """Return the local file for a task attachment.

    ``code-bench/<fixture>.tar.gz`` entries are built from
    ``fixtures/code_bench`` into a private temp dir (registered for cleanup);
    every other name is a static asset under ``TEST_ASSETS_DIR``.
    """
    from benchmarks import code_bench

    if not attach_filename.startswith(code_bench.ATTACHMENT_PREFIX):
        return os.path.join(TEST_ASSETS_DIR, attach_filename)
    build_dir = tempfile.mkdtemp(prefix="code-bench-attachment-")
    cleanup_paths.append(build_dir)
    return str(code_bench.resolve_attachment(attach_filename, Path(build_dir)))


def slice_csv(filepath: str, row_start: int, row_end: int) -> str:
    """
    Slice a CSV file to only include data rows [row_start, row_end] (1-indexed, inclusive).
    Returns path to a temp CSV file with the header + sliced rows.
    """
    with open(filepath, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    # Convert to 0-indexed
    start_idx = row_start - 1
    end_idx = row_end  # inclusive, so don't subtract 1
    sliced = rows[start_idx:end_idx]

    if not sliced:
        raise ValueError(f"No rows in range [{row_start}, {row_end}] (CSV has {len(rows)} data rows)")

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".csv", prefix="benchmark-slice-", delete=False, newline="")
    writer = csv.writer(tmp)
    writer.writerow(header)
    writer.writerows(sliced)
    tmp.close()
    print(f"    ✂ Sliced CSV rows {row_start}-{row_end} ({len(sliced)} rows) → {os.path.basename(tmp.name)}")
    return tmp.name


# ============================================================
# Run a single task
# ============================================================


def _should_delete_agent_after_run(passed: bool, keep_failed_agents: bool) -> bool:
    """Return whether benchmark cleanup should delete the created agent."""
    if cloud_batch_cleanup.contract() is not None:
        return False
    if os.environ.get("BENCHMARK_KEEP_AGENTS") == "true":
        return False
    return passed or not keep_failed_agents


def _should_delete_cancelled_agent(keep_failed_agents: bool) -> bool:
    """Owner interruption overrides diagnostic retention, never explicit audit retention."""
    if cloud_batch_cleanup.contract() is not None:
        return False
    if os.environ.get("BENCHMARK_KEEP_AGENTS") == "true":
        return False
    return not keep_failed_agents or os.environ.get("BENCHMARK_DELETE_CANCELLED_AGENTS_ON_INTERRUPT") == "true"


def _early_fail_should_pause_agent(reason: Optional[str]) -> bool:
    """Return whether an early-failed benchmark should stop agent work immediately."""
    if not reason:
        return False
    normalized = reason.lower()
    return normalized.startswith("timeout after") or "tree stalled" in normalized


_BROWSER_TERMINAL_ACTION_TYPES = frozenset({"task_complete", "session_paused", "write_lock_rejected"})


def _agent_messages_have_browser_terminal(messages: Optional[List[dict]]) -> bool:
    """True when every open spawn_browser_agent task has a terminal action_type.

    FE ``computeActiveBrowserPanels`` keeps a live chip open until it sees
    ``task_complete`` / ``session_paused`` / ``write_lock_rejected``. A FINISHED
    ``recording`` row alone does not close the panel — which is why timeout hub
    archives historically showed active browser chips with recordings attached.
    """
    open_task_ids: set[str] = set()
    terminal_task_ids: set[str] = set()
    tool_call_scoped_terminal = False
    for message in messages or []:
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "spawn_browser_agent":
            continue
        action_type = metadata.get("action_type")
        task_id = metadata.get("task_id")
        if isinstance(task_id, str) and task_id:
            if action_type in _BROWSER_TERMINAL_ACTION_TYPES:
                terminal_task_ids.add(task_id)
            elif action_type in {"browser", "session_starting", "session_init", "task_started"}:
                open_task_ids.add(task_id)
        elif action_type in _BROWSER_TERMINAL_ACTION_TYPES:
            tool_call_scoped_terminal = True
    if tool_call_scoped_terminal:
        return True
    if not open_task_ids:
        return True
    return open_task_ids.issubset(terminal_task_ids)


def _recording_attachment_ready(metadata: dict) -> bool:
    """True when a FINISHED recording row carries a playable FE attachment."""
    if metadata.get("action_type") != "recording":
        return False
    if metadata.get("toolStatus") != "FINISHED":
        return False
    view_url = metadata.get("recording_view_url")
    if isinstance(view_url, str) and view_url.strip():
        return True
    view_urls = metadata.get("recording_view_urls")
    if isinstance(view_urls, list) and any(isinstance(url, str) and url.strip() for url in view_urls):
        return True
    file_pointer = metadata.get("recording_file_pointer")
    return isinstance(file_pointer, dict) and bool(file_pointer.get("storage_path") or file_pointer.get("id"))


def _agent_messages_have_browser_recording_ready(
    messages: Optional[List[dict]],
) -> bool:
    """True when every started browser recording part has its own playable media.

    Timeout cleanup posts ``session_paused`` / ``task_complete`` and finalizes
    Kernel replay asynchronously. Hub archives that snapshot as soon as the
    terminal lands (before the FINISHED recording row) leave the FE Recording
    tab empty even though Kernel already has the MP4.
    """
    started_task_ids: set[str] = set()
    ready_task_ids: set[str] = set()
    pending_parts: set[tuple] = set()
    for message in messages or []:
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if metadata.get("toolName") != "spawn_browser_agent":
            continue
        if metadata.get("action_type") != "recording":
            continue
        task_id = metadata.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        started_task_ids.add(task_id)
        native = metadata.get("browser_session_metadata")
        native = native if isinstance(native, dict) else {}
        # A resumed activity records another part of the same task. Its start
        # must be followed by its own saved media, not an earlier task replay.
        part = (
            task_id, metadata.get("workflowGeneration"), metadata.get("browser_url"),
            native.get("provider") or metadata.get("provider"),
            next((native.get(key) or metadata.get(key) for key in
                  ("session_id", "browser_session_id", "kernel_session_id")
                  if native.get(key) or metadata.get(key)), None),
        )
        if any(value is not None and not isinstance(value, str) for value in part):
            return False
        if metadata.get("toolStatus") == "IN_PROGRESS":
            if part in pending_parts:
                return False  # An earlier part never finished before another began.
            pending_parts.add(part)
        if _recording_attachment_ready(metadata):
            pending_parts.discard(part)
            ready_task_ids.add(task_id)
    if not started_task_ids:
        return True
    return not pending_parts and started_task_ids.issubset(ready_task_ids)


def _agent_messages_ready_for_browser_hub_archive(
    messages: Optional[List[dict]],
) -> bool:
    """Terminal chip close + playable recording — both required for hub FE links."""
    return _agent_messages_have_browser_terminal(messages) and _agent_messages_have_browser_recording_ready(messages)


def _agent_messages_ready_for_durable_browser_evidence(
    messages: Optional[List[dict]],
    *,
    zero_session_task_ids: set[str] | None = None,
    preparation_cancelled_task_ids: set[str] | None = None,
) -> bool:
    """Require terminal recording or verified cancellation before browser actions."""
    states: dict[str, dict[str, bool]] = {}
    lifecycle = {
        "browser",
        "session_init",
        "session_started",
        "task_started",
        "recording",
        "network_recording",
        "task_complete",
    }
    for row in extract_message_transcript({"messages": messages or []}):
        meta = row.get("metadata")
        if not isinstance(meta, dict) or not isinstance(meta.get("task_id"), str) or not meta["task_id"]:
            continue
        action = meta.get("action_type")
        browser = (
            meta.get("toolName") == "spawn_browser_agent"
            or meta.get("agentType") == "browser"
            or action in {"browser", "recording", "network_recording"}
        )
        code = meta.get("toolName") == "spawn_claude_code_agent" or meta.get("agentType") == "code"
        if not browser and not code and action not in lifecycle:
            continue
        state = states.setdefault(
            meta["task_id"], {"browser": False, "code": False, "complete": False, "recording": False}
        )
        state["browser"] |= browser
        state["code"] |= code
        state["complete"] |= action == "task_complete"
        # The durable publisher accepts this singular URL or an attached file.
        state["recording"] |= _recording_attachment_ready({**meta, "recording_view_urls": []})
    return _agent_messages_have_browser_recording_ready(messages) and all(
        (state["code"] and not state["browser"])
        or (
            state["complete"]
            and (
                state["recording"]
                or task_id in (zero_session_task_ids or set())
                or task_id in (preparation_cancelled_task_ids or set())
            )
        )
        for task_id, state in states.items()
    )


def _retain_harness_benchmark_state(source: dict, refreshed: dict) -> dict:
    """Carry harness-only ``_benchmark`` evidence onto a fresh agent read.

    A live agent read knows nothing about evidence the poll loop observed (gates,
    Checkout, attention order, receipts). Replacing the transcript must not erase
    it, or evaluation reports contract failures the run never had.
    """
    if refreshed is source:
        return refreshed
    source_benchmark = source.get("_benchmark")
    refreshed_benchmark = refreshed.get("_benchmark")
    refreshed["_benchmark"] = {
        **(refreshed_benchmark if isinstance(refreshed_benchmark, dict) else {}),
        **(source_benchmark if isinstance(source_benchmark, dict) else {}),
    }
    return refreshed


async def _refresh_agent_after_pause_for_browser_terminal(
    base_url: str,
    agent_id: str,
    data: dict,
    *,
    timeout_seconds: float = 60.0,
    poll_interval_seconds: float = 2.0,
    readiness_check: Callable[[Optional[List[dict]]], bool] = (_agent_messages_ready_for_browser_hub_archive),
) -> dict:
    """Re-fetch agent messages after pause so hub archives include browser terminals.

    Timeout/stall paths pause the agent *after* the poll snapshot. Cancel +
    recording cleanup then post ``task_complete`` / ``session_paused`` and finalize
    the recording asynchronously. Archiving the pre-pause snapshot leaves FE links
    with an IN_PROGRESS browser chip forever. Archiving as soon as ``session_paused``
    lands (before Kernel replay finalize) leaves the Recording tab empty.
    """
    if readiness_check(data.get("messages")):
        return data
    deadline = time.time() + timeout_seconds
    latest = data
    while time.time() < deadline:
        await asyncio.sleep(poll_interval_seconds)
        try:
            latest = await get_agent(base_url, agent_id)
        except Exception as refresh_error:
            print(f"    ⚠ Browser-terminal refresh failed: {refresh_error}")
            continue
        if readiness_check(latest.get("messages")):
            print(f"    ✓ Browser terminal messages landed after pause ({len(latest.get('messages') or [])} messages)")
            return _retain_harness_benchmark_state(data, latest)
    print("    ⚠ Timed out waiting for browser terminal messages after pause; archiving latest snapshot anyway")
    return _retain_harness_benchmark_state(data, latest)


async def _refresh_browser_archive_snapshot(
    base_url: str,
    agent_id: str,
    data: dict,
    logs: dict,
    *,
    expected_agent_ids: set[str] | None = None,
    timeout_seconds: float = 60.0,
    ownership_before: dict | None = None,
) -> dict:
    """Refresh the entire tree at the final archive boundary; incomplete evidence fails closed."""
    observed_snapshots: dict[str, dict] = {}
    async with asyncio.timeout(timeout_seconds):
        deadline = time.monotonic() + timeout_seconds
        while True:
            observation = {
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "ready": False,
                "phase": "tree_fetch",
                "completed_agent_ids": [],
                "snapshots": dict(observed_snapshots),
            }
            logs["browser_archive_observation"] = observation
            tree_agents = await get_agent_tree(base_url, agent_id)
            ids = {str(info.get("agent_id")) for info in tree_agents}
            expected = expected_agent_ids or {agent_id}
            if not expected.issubset(ids):
                raise RuntimeError("archive tree omitted an owned agent")
            # Large paused trees share one backend/database. Avoid a burst of
            # dozens of full-transcript reads while retaining every agent and
            # the same archive deadline and terminal/recording requirements.
            read_slots = asyncio.Semaphore(8)
            observation["phase"] = "agent_snapshots"
            observation["expected_agent_ids"] = sorted(ids)

            async def fetch_snapshot(aid):
                async with read_slots:
                    snapshot = await get_agent(base_url, aid)
                    observed_snapshots[aid] = snapshot
                    observation["snapshots"][aid] = snapshot
                    observation["completed_agent_ids"].append(aid)
                    return snapshot

            snapshots = dict(zip(sorted(ids), await asyncio.gather(*(fetch_snapshot(aid) for aid in sorted(ids)))))
            logs["browser_archive_observation"] = {
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "ready": False,
                "phase": "browser_readiness",
                "snapshots": snapshots,
            }
            latest = snapshots[agent_id]
            if time.monotonic() >= deadline:
                raise TimeoutError("browser archive refresh exceeded its readiness bound")
            zero_tasks_by_agent: dict[str, set[str]] = {}
            from benchmarks.browser_zero_allocation import (
                preparation_cancelled_task_receipts,
                preparation_receipts_match_sessions,
            )

            preparation_by_agent = {
                aid: preparation_cancelled_task_receipts(value.get("messages"), aid) for aid, value in snapshots.items()
            }
            preparation_receipts = {
                task_id: receipt for tasks in preparation_by_agent.values() for task_id, receipt in tasks.items()
            }
            preparation_snapshot = None
            if preparation_receipts:
                preparation_snapshot = await asyncio.to_thread(
                    cloud_batch_cleanup.exact_root_sessions, base_url, agent_id
                )
                if set(
                    preparation_snapshot.get("tree_agent_ids") or []
                ) != ids or not preparation_receipts_match_sessions(preparation_receipts, preparation_snapshot):
                    preparation_by_agent = {}
                    preparation_receipts = {}
            if (
                ownership_before is not None
                and ownership_before.get("browser_sessions") == []
                and set(ownership_before.get("tree_agent_ids") or []) == ids
            ):
                from benchmarks.browser_zero_allocation import cancelled_before_session_task_ids

                candidates_by_agent = {
                    aid: cancelled_before_session_task_ids(value.get("messages")) for aid, value in snapshots.items()
                }
                if any(candidates_by_agent.values()):
                    current = await asyncio.to_thread(cloud_batch_cleanup.exact_root_sessions, base_url, agent_id)
                    if current["browser_sessions"] == [] and set(current["tree_agent_ids"]) == ids:
                        zero_tasks_by_agent = candidates_by_agent
            if all(
                _agent_messages_ready_for_durable_browser_evidence(
                    value.get("messages"),
                    zero_session_task_ids=zero_tasks_by_agent.get(aid),
                    preparation_cancelled_task_ids=set(preparation_by_agent.get(aid, {})),
                )
                for aid, value in snapshots.items()
            ):

                async def cached_get(aid):
                    return snapshots[aid]

                tree = canonicalize_agent_tree(await collect_tree_messages(agent_id, tree_agents, cached_get))
                if set(tree) != ids:
                    raise RuntimeError("archive tree transcript capture was incomplete")
                latest["_benchmark"] = {**latest.get("_benchmark", {}), **data.get("_benchmark", {})}
                logs["messages"] = extract_message_transcript(latest)
                logs["tree"] = tree
                if preparation_receipts:
                    logs["browser_preparation_cancellation_receipt"] = {
                        "root_agent_id": agent_id,
                        "tree_agent_ids": sorted(ids),
                        "task_ids_by_agent": {
                            aid: sorted(tasks) for aid, tasks in preparation_by_agent.items() if tasks
                        },
                        "receipts": preparation_receipts,
                        "archive_browser_sessions": preparation_snapshot["browser_sessions"],
                    }
                if any(zero_tasks_by_agent.values()):
                    logs["browser_zero_allocation_receipt"] = {
                        "root_agent_id": agent_id,
                        "task_ids": sorted({task_id for tasks in zero_tasks_by_agent.values() for task_id in tasks}),
                        "task_ids_by_agent": {
                            aid: sorted(tasks) for aid, tasks in zero_tasks_by_agent.items() if tasks
                        },
                        "tree_agent_ids": sorted(ids),
                        "before_browser_sessions": [],
                        "archive_browser_sessions": [],
                    }
                logs.pop("browser_archive_observation", None)
                return latest
            if time.monotonic() >= deadline:
                raise TimeoutError("browser evidence did not become terminal with attached recordings before archive")
            await asyncio.sleep(min(2, max(0, deadline - time.monotonic())))


async def _finalize_owned_root_payments(base_url: str, root_id: str, evidence: dict) -> dict:
    """Drain admitted purchases through canonical compensation before DB teardown."""
    attempted = set()
    async with asyncio.timeout(PAYMENT_CLEANUP_TIMEOUT_SECONDS):
        while True:
            snapshot = await asyncio.to_thread(
                cloud_batch_cleanup.exact_root_sessions,
                base_url,
                root_id,
                require_deleted=True,
            )
            evidence["payment_snapshot"] = snapshot
            pending = cloud_batch_cleanup.pending_root_payments(snapshot)
            if not pending:
                return {"root_agent_id": root_id, "purchases": snapshot["purchase_cleanup"]}
            # An accepted mint remains visible before its remote side effects
            # finish. Do not classify its early empty card/transfer as cleanup.
            actionable = [row for row in pending if row["status"] not in {"PENDING_APPROVAL", "CHARGING"}]
            new_attempts = [row for row in actionable if row["purchase_id"] not in attempted]
            errors = []
            for agent_id in sorted({row["agent_id"] for row in new_attempts}):
                attempted.update(row["purchase_id"] for row in new_attempts if row["agent_id"] == agent_id)
                # The endpoint closes every exact-agent purchase. Its response
                # may be best effort, so only the next durable ledger read can
                # complete this contract, including for non-abandonment tasks.
                try:
                    await _start_payment_abandonment_with_recovery(
                        base_url,
                        agent_id,
                        abandon_payment=abandon_test_payment,
                    )
                except Exception as error:
                    errors.append(f"{agent_id}: {str(error) or type(error).__name__}")
            if errors:
                raise RuntimeError("; ".join(errors))
            if not new_attempts:
                await asyncio.sleep(2)


async def _owned_payments_release_stalled(base_url: str, evidence: dict, *, task_name: str) -> bool:
    """Every still-pending owned purchase is waiting only on AgentCard release in the expected mode."""
    try:
        pending = cloud_batch_cleanup.pending_root_payments(evidence.get("payment_snapshot") or {})
    except Exception:
        return False
    lifecycles = {}
    for agent_id in sorted({row["agent_id"] for row in pending}):
        try:
            lifecycles[agent_id] = await get_test_payment_lifecycle(base_url, agent_id)
        except Exception:
            return False
    evidence["agentcard_release_stall_lifecycles"] = lifecycles
    return bool(pending) and all(
        row["status"] == "HELD"
        and row["funding_status"] == "RECLAIMING"
        and _agentcard_release_skip_lifecycle(task_name, lifecycles[row["agent_id"]])
        and lifecycles[row["agent_id"]].get("agentId") == row["agent_id"]
        and lifecycles[row["agent_id"]]["purchase"].get("id") == row["purchase_id"]
        and lifecycles[row["agent_id"]]["purchase"].get("stripePaymentIntentId") == row["stripe_payment_intent_id"]
        and lifecycles[row["agent_id"]]["purchase"].get("totalCents") == row["total_cents"]
        and lifecycles[row["agent_id"]]["orgTransfer"].get("id") == row["provider_transfer_id"]
        and lifecycles[row["agent_id"]]["orgTransfer"].get("cardId") == row["card_id"]
        for row in pending
    )


async def _wait_for_owned_root_seal(
    base_url: str,
    root_id: str,
    before: dict,
    evidence: dict,
    *,
    timeout_seconds: float = 180.0,
) -> dict:
    """A disconnected DELETE may still be sealing descendants in the backend."""
    try:
        async with asyncio.timeout(timeout_seconds):
            while True:
                snapshot = await asyncio.to_thread(cloud_batch_cleanup.exact_root_sessions, base_url, root_id)
                unsealed = snapshot.get("unsealed_tree_agent_ids")
                if (
                    snapshot.get("root_user_id") != before["root_user_id"]
                    or not set(before["tree_agent_ids"]).issubset(snapshot["tree_agent_ids"])
                    or not isinstance(unsealed, list)
                    or any(aid not in snapshot["tree_agent_ids"] for aid in unsealed)
                ):
                    raise RuntimeError("owned root identity or sealing evidence changed after DELETE")
                evidence["delete_seal_observation"] = {
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                    "snapshot": snapshot,
                }
                if snapshot.get("root_deleted") is True and unsealed == []:
                    return await asyncio.to_thread(
                        cloud_batch_cleanup.exact_root_sessions,
                        base_url,
                        root_id,
                        require_deleted=True,
                    )
                await asyncio.sleep(2)
    except TimeoutError as error:
        raise RuntimeError("exact owned tree did not seal before the cleanup deadline") from error


async def _finalize_owned_cloud_batch(base_url: str, results: list, live_ids: dict[str, list[str]], *, never_admitted_results: tuple = ()) -> None:
    """Finalize each owned root after all tasks, while workers can still persist cleanup."""
    # A missing create response cannot prove that no root was allocated.
    failures = []
    by_id = {}
    stage_logs = {}
    primary_ids = set()
    for result in results:
        explicit_roots = getattr(result, "owned_roots", None) or []
        for record in explicit_roots:
            aid = record.get("root_agent_id")
            valid = (record.get("task_name") == result.name and record.get("role") in {"fixture_first_run", "graded"}
                     and record.get("creation") == {"source": "create_agent_return", "root_agent_id": aid}
                     and isinstance(record.get("logs"), dict))
            try:
                valid = valid and isinstance(aid, str) and str(uuid.UUID(aid)) == aid
            except ValueError:
                valid = False
            snapshot = (record.get("logs") or {}).get("fixture_snapshot") if isinstance(record.get("logs"), dict) else None
            if isinstance(snapshot, dict) and (snapshot.get("agent") or {}).get("id") not in {None, aid}:
                valid = False
            if not valid or aid in by_id:
                failures.append(f"{result.name}: invalid or duplicate exact root custody")
                continue
            if record["role"] == "graded" and aid != result.agent_id:
                failures.append(f"{result.name}: graded root custody mismatch")
                continue
            by_id[aid] = result
            stage_logs[aid] = record["logs"]
        if not result.agent_id:
            continue
        root_ids = result.agent_id.split(",")
        if len(root_ids) == 1:
            bindings = [(root_ids[0], result.logs)]
        else:
            # Composite tasks record one benchmark result for independent
            # prerequisite/task roots. Preserve that evaluator result while
            # finalizing each root's own archive and external ownership.
            try:
                valid_roots = len(root_ids) == len(set(root_ids)) and all(
                    str(uuid.UUID(aid)) == aid for aid in root_ids
                )
            except ValueError:
                valid_roots = False
            if not valid_roots:
                failures.append(f"{result.name}: malformed composite root identity")
                continue
            nested = [
                logs
                for logs in (result.logs or {}).values()
                if isinstance(logs, dict) and isinstance(logs.get("worker_logs"), list)
            ]
            if len(nested) != len(root_ids):
                failures.append(f"{result.name}: composite root evidence is incomplete")
                continue
            bindings = list(zip(root_ids, nested))
            for aid, logs in bindings:
                # The stage ordering comes from the same composite routine
                # that joined agent_id. Check the log/tree anchor so a swapped
                # or foreign stage cannot silently receive another root's
                # cleanup receipt.
                tree = logs.get("tree") or {}
                observed = set()
                for raw in logs["worker_logs"]:
                    try:
                        event = json.loads(raw) if isinstance(raw, str) else raw
                    except (TypeError, ValueError):
                        continue
                    if isinstance(event, dict) and isinstance(event.get("agent_id"), str):
                        observed.add(event["agent_id"])
                if aid not in tree and aid not in observed:
                    failures.append(f"{result.name}: composite stage lacks exact root {aid}")
                if (set(root_ids) - {aid}) & (set(tree) | observed):
                    failures.append(f"{result.name}: composite stage contains a foreign root")
        for aid, logs in bindings:
            if aid in by_id and explicit_roots and by_id[aid] is result and any(row.get("root_agent_id") == aid and row.get("role") == "graded" for row in explicit_roots):
                stage_logs[aid] = logs if isinstance(logs, dict) else {}
                continue
            if aid in by_id:
                failures.append(f"{result.name}: duplicate exact root {aid}")
                continue
            by_id[aid] = result
            stage_logs[aid] = logs if isinstance(logs, dict) else {}
        primary_ids.add(root_ids[-1])
    owned = {aid for ids in live_ids.values() for aid in ids} | set(by_id)
    # The SMS supervisor is an in-backend tool loop, not a Temporal agent.
    # Its runner returns only after its own seeded-session cleanup completed.
    # Keep every other missing root fail-closed: an interrupted create may
    # still own sessions even when its HTTP response never reached us.
    rootless_sms = [
        r
        for r in results
        if not r.agent_id
        and r.status != "SKIPPED"
        and isinstance(getattr(r, "stop_metadata", None), dict)
        and r.stop_metadata.get("runner") == "sms"
        and r.stop_metadata.get("owned_cleanup_verified") is True
    ]
    rootless_credentials = [r for r in results if any(r is proof for proof in never_admitted_results)
        and not r.agent_id and not getattr(r, "owned_roots", None) and not getattr(r, "logs", None)
        and not live_ids.get(r.name) and r.status == r.benchmark_status == "SKIPPED" and r.passed is False
        and _is_permitted_claude_code_skip(r)
        and getattr(r, "graded_root_creation_outcome", None) == "not_started"
        and getattr(r, "stop_metadata", None) == {"runner": "benchmark_preflight", "admission": "not_started",
                                                  "reason": "claude_credential_unavailable"}]
    rootless_queued = [r for r in results if any(r is proof for proof in never_admitted_results)
        and not r.agent_id and not getattr(r, "owned_roots", None) and not getattr(r, "logs", None)
        and r.status == r.benchmark_status == "CANCELLED" and r.passed is False
        and getattr(r, "graded_root_creation_outcome", None) == "not_started"
        and isinstance(meta := getattr(r, "stop_metadata", None), dict)
        and meta == {"runner": "benchmark_coordinator", "admission": "not_started", "occurrence_index": meta.get("occurrence_index")}
        and type(meta.get("occurrence_index")) is int and meta["occurrence_index"] >= 0]
    if len(rootless_queued) + len(rootless_credentials) != len(never_admitted_results):
        failures.append("invalid coordinator nonadmission proof")
    if any(not r.agent_id and r.status != "SKIPPED" and r not in rootless_sms and not any(r is proof for proof in rootless_queued)
           and not (getattr(r, "graded_root_creation_outcome", None) == "not_started"
                    and getattr(r, "owned_roots", None)) for r in results) or any(
                        getattr(r, "graded_root_creation_outcome", None) == "unknown" for r in results):
        failures.append("owned cloud execution has an unknown root creation outcome")
    if not owned:
        rootless = [*rootless_sms, *rootless_queued, *rootless_credentials]
        if failures or not rootless or any(not any(r is proof for proof in rootless) for r in results):
            raise RuntimeError("; ".join(failures) or "owned cloud execution has no proven root allocation")
        return
    snapshots = {}
    preparation_warnings = {}
    # An operator/watchdog interrupt (asyncio.run's SIGINT cancellation) may
    # land in any wait below. The evaluated outcomes are already final, and the
    # archive is diagnostic, so stop archiving but still carry every owned root
    # through exact pause/release before re-raising the interruption.
    interrupted: asyncio.CancelledError | None = None
    for aid in sorted(owned):
        try:
            # Task-scoped fixture identities have already been restored. Bind
            # cleanup to the exact root's persisted owner, never the ambient user.
            before = await asyncio.to_thread(cloud_batch_cleanup.exact_root_sessions, base_url, aid)
            owner = before["root_user_id"]
            snapshots[aid] = before
            identity = _owned_cleanup_user_id.set(owner)
            try:
                if not await pause_agent(base_url, aid):
                    raise RuntimeError("pause was not acknowledged")
            finally:
                _owned_cleanup_user_id.reset(identity)
        except (Exception, asyncio.CancelledError) as error:
            if isinstance(error, asyncio.CancelledError):
                interrupted = interrupted or error
                detail = "interrupted"
            else:
                detail = str(error) or type(error).__name__
            if aid in snapshots:
                # A lost pause acknowledgment can be recovered by the exact
                # sealed-tree/provider/payment proof below.
                preparation_warnings[aid] = [f"pause: {detail}"]
            else:
                failures.append(f"{aid}: {detail}")
    for aid in sorted(owned):
        result = by_id.get(aid)
        before = snapshots.get(aid)
        identity = _owned_cleanup_user_id.set(before["root_user_id"]) if before is not None else None
        try:
            logs = stage_logs.get(aid, {})
            evidence = {"root_agent_id": aid, "errors": [], "warnings": preparation_warnings.get(aid, [])}
            logs["cloud_cleanup_evidence"] = evidence
            def emit_cleanup_diagnostic(message):
                # Output delivery cannot invalidate canonical resource evidence.
                try:
                    print(message)
                except BrokenPipeError:
                    evidence["warnings"].append("diagnostic output: BrokenPipeError")
            if result is None:
                detail = "owned cloud root did not produce a task result"
                evidence["errors"].append(f"execution: {detail}")
                failures.append(f"{aid}: {detail}")
            try:
                if before is None:
                    raise RuntimeError("exact provider ownership was not established")
                evidence["before"] = before
                if interrupted is not None:
                    raise RuntimeError("benchmark interrupted before archive refresh")
                # Pausing a root starts browser recording finalization in the
                # worker. Each owned Kernel session can take a separate replay
                # stop/read cycle; deleting the root after the old fixed 60s
                # bound makes late recording messages return 404. Keep the
                # root alive for a bounded, session-scaled archive wait. The
                # refresh returns immediately when all recordings are ready.
                archive_timeout_seconds = min(600.0, 60.0 + 30.0 * len(before["browser_sessions"]))
                data = await _refresh_browser_archive_snapshot(
                    base_url,
                    aid,
                    {},
                    logs,
                    expected_agent_ids=set(before["tree_agent_ids"]),
                    timeout_seconds=archive_timeout_seconds,
                    ownership_before=before,
                )
                if result is None:
                    raise RuntimeError("owned cloud root did not produce a task result")
                if aid in primary_ids and "," not in result.agent_id:
                    result.message_count = len(data.get("messages") or [])
                fixture_root = any(
                    root.get("root_agent_id") == aid and root.get("role") == "fixture_first_run"
                    for root in (getattr(result, "owned_roots", None) or [])
                )
                if fixture_root:
                    archive_ref = await archive_agent_finalize(base_url, aid, result.name, force=True)
                    world_model_fidelity = None
                else:
                    archive_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
                        base_url,
                        aid,
                        result.name,
                        force=True,
                        owned_batch_final=True,
                        benchmark_passed=result.passed,
                        benchmark_status=result.benchmark_status,
                        failure_reason=result.failure_reason,
                    )
                logs["cloud_archive_manifest_ref"] = archive_ref
                logs["cloud_world_model_fidelity"] = world_model_fidelity
                if aid in primary_ids:
                    result.archive_manifest_ref = archive_ref
                    result.world_model_fidelity = world_model_fidelity
                if not archive_ref:
                    raise RuntimeError("owned cloud root final archive was not confirmed")
            except (Exception, asyncio.CancelledError) as error:
                if isinstance(error, asyncio.CancelledError):
                    interrupted = interrupted or error
                    detail = "interrupted during archive refresh"
                else:
                    detail = str(error) or type(error).__name__
                # Archive/publication is diagnostic. Preserve the evaluator's
                # terminal outcome while still requiring exact resource release.
                evidence["warnings"].append(f"archive: {detail}")
                emit_cleanup_diagnostic(f"    Cloud archive warning: {aid}: {detail}")
            finally:
                # Even failed evidence must release its exact resources. A DELETE
                # response alone is insufficient because backend cleanup is best effort.
                try:
                    if before is None:
                        raise RuntimeError("exact provider ownership was not established")
                    try:
                        await delete_agent(base_url, aid)
                    except httpx.TransportError as error:
                        evidence["delete_transport_error"] = str(error) or type(error).__name__
                        # The request can outlive its HTTP connection while
                        # recursively sealing a large tree. No provider/payment
                        # authority is granted until the exact DB fence completes.
                        await _wait_for_owned_root_seal(base_url, aid, before, evidence)
                    receipt = await asyncio.to_thread(
                        cloud_batch_cleanup.close_exact_root_sessions,
                        base_url,
                        aid,
                        before,
                        evidence=evidence,
                    )
                    logs["cloud_provider_cleanup"] = receipt
                    emit_cleanup_diagnostic(f"    Verified cloud root provider cleanup: {aid}")
                except Exception as error:
                    detail = str(error) or type(error).__name__
                    evidence["errors"].append(f"provider: {detail}")
                    failures.append(f"{aid}: {detail}")
                    if result is not None:
                        _record_owned_cleanup_failure(result, evidence, error)
                try:
                    if before is None:
                        raise RuntimeError("exact payment ownership was not established")
                    logs["cloud_payment_cleanup"] = await _finalize_owned_root_payments(base_url, aid, evidence)
                except Exception as error:
                    detail = str(error) or type(error).__name__
                    if (
                        isinstance(error, TimeoutError)
                        and result is not None
                        and _agentcard_release_skip_task(result.name)
                        and _agentcard_release_skip_enabled()
                        and await _owned_payments_release_stalled(
                            base_url, evidence, task_name=result.name
                        )
                    ):
                        evidence["warnings"].append(f"payment: {AGENTCARD_RELEASE_SKIP_REASON}")
                        _warn_agentcard_release_skip(result.name if result is not None else aid, f"{aid}: {detail}")
                        if result is not None and result.passed:
                            result.passed = False
                            result.status = "SKIPPED"
                            result.benchmark_status = "SKIPPED"
                            result.failure_reason = f"{AGENTCARD_RELEASE_SKIP_REASON}: {aid}: {detail}"
                    else:
                        evidence["errors"].append(f"payment: {detail}")
                        failures.append(f"{aid}: {detail}")
                        if result is not None:
                            _record_owned_cleanup_failure(result, evidence, error)
                if result is not None:
                    if evidence["errors"] or evidence["warnings"]:
                        try:
                            cleanup_worker_logs = await asyncio.to_thread(fetch_local_worker_logs, aid, newest=True)
                            # Preserve the prior capture alongside the newest 20k
                            # diagnostics (at most 40k for two capped captures).
                            logs["worker_logs"] = list(
                                dict.fromkeys(
                                    [
                                        *(logs.get("worker_logs") or []),
                                        *cleanup_worker_logs,
                                    ]
                                )
                            )
                            evidence["worker_logs_observed_at"] = datetime.now(timezone.utc).isoformat()
                        except Exception as capture_error:
                            evidence["worker_logs_capture_error"] = str(capture_error) or type(capture_error).__name__
                    if aid in primary_ids and "," not in result.agent_id:
                        result.logs = logs
        finally:
            if identity is not None:
                _owned_cleanup_user_id.reset(identity)
    if interrupted is not None:
        # Exact release completed for every owned root iff nothing failed. The
        # caller publishes that verdict; the interruption itself still wins.
        interrupted.owned_batch_cleanup_verified = not failures
        interrupted.owned_batch_cleanup_failures = list(failures)
        raise interrupted
    if failures:
        raise RuntimeError("owned cloud evidence finalization failed: " + "; ".join(failures))


def _owned_stack_stopped(error: BaseException | None) -> bool:
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, cloud_batch_cleanup.OwnedStackStoppedError):
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


def _record_owned_cleanup_failure(result: Any, evidence: dict, error: BaseException) -> None:
    """A genuine provider/payment cleanup failure fails the task (an unreleased
    resource is part of its outcome). When the verifier could not run because the
    owned stack had already stopped (T114: backend killed mid-finalization), the
    graded verdict stands and the unverified cleanup fails the run and CI instead."""
    reason = "Cloud cleanup failed: " + "; ".join(evidence["errors"])
    if _owned_stack_stopped(error):
        result.cleanup_failure = reason
        return
    result.passed = False
    result.benchmark_status = "ERROR"
    result.failure_reason = reason


async def _finalize_owned_batch_and_save_run(
    base_url: str,
    run: Any,
    live_ids: dict[str, list[str]],
    *,
    owned_batch_cleanup: bool,
    retrieval_audit: Callable[[], Any],
    never_admitted_results: tuple = (),
) -> None:
    """Finalize owned cloud roots, then persist the run record exactly once."""
    # All selected execution has finished. Keep workers and backend available
    # while recordings finalize, then freeze terminal evidence once.
    batch_cleanup_error: BaseException | None = None
    if owned_batch_cleanup:
        try:
            await _finalize_owned_cloud_batch(base_url, run.task_results, live_ids,
                                              never_admitted_results=never_admitted_results)
            _complete_interrupt_cleanup()
        except BaseException as error:
            # An interrupt here arrives after every outcome was evaluated. Save
            # the record before propagating it, or the run reads as UNKNOWN.
            if getattr(error, "owned_batch_cleanup_verified", False) is True:
                _complete_interrupt_cleanup()
            batch_cleanup_error = error

    # Always save results — even partial results from interrupted runs are valuable
    if run.task_results:
        run.world_model_retrieval_audit = retrieval_audit()
        path = run.save()
        print(f"\n  Results saved: {path}")
        try:
            context_dir = Path(os.environ.get("BENCHMARK_CONTEXT_DIR", ".context"))
            context_dir.mkdir(parents=True, exist_ok=True)
            (context_dir / "run.json").write_text(Path(path).read_text(), encoding="utf-8")
        except Exception as exc:
            print(f"  ⚠ run.json archive write failed (non-fatal): {exc}")

    if batch_cleanup_error is not None:
        raise batch_cleanup_error


async def _capture_task_failure_evidence(
    base_url: str, agent_id: str, task: BenchmarkTask, data: dict, start_time: datetime,
) -> tuple[dict, dict]:
    """Retain the last owned snapshot even when refresh or log transport fails."""
    errors = []
    try:
        refreshed = await get_agent(base_url, agent_id)
        owner = refreshed.get("agent", {}).get("id") or refreshed.get("agent", {}).get("agent_id")
        if owner and owner != agent_id:
            raise ValueError("failure snapshot belongs to another agent")
        if refreshed.get("messages") and len(refreshed["messages"]) >= len(data.get("messages", [])):
            data = _retain_harness_benchmark_state(data, refreshed)
        elif not data.get("messages"):
            errors.append("No authoritative messages available from agent read")
    except Exception as exc:
        errors.append(f"snapshot: {type(exc).__name__}: {exc}")
    if task.payment_card_request_action == "abandon":
        data, seal_error = await _seal_payment_abandonment_browser_for_archive(base_url, agent_id, data)
        if seal_error:
            errors.append(seal_error)
    try:
        logs = await collect_logs(agent_id, data, start_time, backend_url=base_url)
    except Exception as exc:
        errors.append(f"logs: {type(exc).__name__}: {exc}")
        logs = {}
    logs["messages"] = extract_message_transcript(data)
    try:
        tree_agents = await get_agent_tree(base_url, agent_id)

        async def owned_snapshot(aid):
            return data if aid == agent_id else await get_agent(base_url, aid)

        tree = canonicalize_agent_tree(await collect_tree_messages(agent_id, tree_agents, owned_snapshot))
        if tree:
            logs["tree"] = tree
    except Exception as exc:
        errors.append(f"tree: {type(exc).__name__}: {exc}")
    logs["failure_evidence"] = {
        "agent_id": agent_id, "benchmark_state": data.get("_benchmark", {}), "errors": errors,
    }
    return data, logs


async def _seal_payment_abandonment_browser_for_archive(
    base_url: str,
    agent_id: str,
    data: dict,
) -> tuple[dict, Optional[str]]:
    """Pause an abandoned checkout and retain its terminal browser evidence.

    Payment-abandonment tasks intentionally return while the browser is still
    waiting at the pre-submission checkout boundary. Deleting the agent later
    terminates that browser, but the trace archive and run JSON are frozen before
    deletion. Pause and re-fetch first so the durable Hub bundle contains both
    the terminal chip row and the finalized recording required by evidence-link
    validation.
    """
    if not data.get("messages"):
        return data, "Payment-abandonment browser evidence is missing; empty snapshot cannot authorize sealing"
    if _agent_messages_ready_for_durable_browser_evidence(data.get("messages")):
        return data, None

    try:
        if not await pause_agent(base_url, agent_id):
            return data, "Failed to pause payment-abandonment agent before Hub archive"
        print(f"    ⏸ Paused payment-abandonment agent {agent_id[:12]} before Hub archive")
        refreshed = await _refresh_agent_after_pause_for_browser_terminal(
            base_url,
            agent_id,
            data,
            readiness_check=_agent_messages_ready_for_durable_browser_evidence,
        )
    except Exception as pause_error:
        return data, f"Failed to seal payment-abandonment browser evidence: {pause_error}"

    # Preserve harness-only lifecycle/evaluator fields while replacing the
    # transcript with the post-pause terminal snapshot.
    refreshed = _retain_harness_benchmark_state(data, refreshed)
    if not _agent_messages_ready_for_durable_browser_evidence(refreshed.get("messages")):
        return (
            refreshed,
            "Payment-abandonment browser did not reach terminal state with a recording before Hub archive",
        )
    return refreshed, None


def _local_victoria_db_container() -> Optional[str]:
    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace or not _docker_daemon_ping():
        return None
    container = f"victoria-db-{workspace}"
    ps = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{container}$", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    return container if container in ps.stdout.splitlines() else None


def _services_manifest_is_active(services: dict) -> bool:
    """Return whether a services manifest is authoritative for fixture SQL."""
    status = services.get("status")
    if status in {"failed", "stopped"}:
        return False
    run_sh_pid = services.get("run_sh_pid")
    if run_sh_pid is None:
        return True
    if not isinstance(run_sh_pid, int) or run_sh_pid <= 1:
        return False
    try:
        os.kill(run_sh_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _local_database_url_responds(database_url: str) -> bool:
    """Probe the isolated DB without turning one bounded stall into a crash.

    A restored cloud guest can briefly stop accepting queries while the backend
    and worker finish opening their pools. ``subprocess.run(timeout=...)`` raises
    rather than returning a failed result in that case, so retry only that
    transient boundary. Ordinary query failures still fail closed immediately.
    """
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(
                ["psql", database_url, "-t", "-A", "-c", "SELECT 1;"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            if attempt == attempts:
                return False
            print(f"    ⚠ Local Victoria DB probe timed out; retrying ({attempt}/{attempts})")
            time.sleep(0.25 * attempt)
            continue
        return result.returncode == 0
    return False


def _local_victoria_database_url() -> Optional[str]:
    candidates: list[str] = []
    services_path = _benchmark_context_path() / "services.json"
    if services_path.exists():
        try:
            services = json.loads(services_path.read_text())
            if _services_manifest_is_active(services):
                # An active per-run manifest is the authoritative database
                # identity. Do not turn discovery into a second connectivity
                # gate: cleanup's real SQL owns that check and preserves the
                # underlying psql error when the database is unavailable.
                return manifest_database_url(services)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Invalid benchmark services manifest at {services_path}: {exc}") from exc
    env_database_url = os.environ.get("DIRECT_URL") or os.environ.get("DATABASE_URL")
    if env_database_url:
        candidates.append(_psql_compatible_database_url(env_database_url))
    candidates.append("postgresql://postgres:postgres@localhost:5432/victoria")
    configured_url = load_env_var("DATABASE_URL", _BACKEND_ENV)
    if configured_url:
        candidates.append(_psql_compatible_database_url(configured_url))

    seen: set[str] = set()
    for database_url in candidates:
        if database_url in seen:
            continue
        seen.add(database_url)
        if _local_database_url_responds(database_url):
            return database_url
    return None


def _shared_workspace_database_url() -> Optional[str]:
    """Return a credentialed top-level workspace DB for an isolated run.

    Reachability alone is insufficient: the shared runtime can mark its dev
    token expired and all pooled tokens rate-limited while production already
    has a replacement. In that state, preferring the shared DB makes the
    isolated seed retry deterministic stale data instead of consulting prod.
    """
    shared_context = REPO_ROOT / ".context"
    try:
        if _benchmark_context_path().resolve() == shared_context.resolve():
            return None
    except OSError:
        return None

    services_path = shared_context / "services.json"
    if services_path.exists():
        try:
            services = json.loads(services_path.read_text())
        except (OSError, ValueError):
            return None
        if services.get("status") in {"failed", "stopped"}:
            return None

        database = services.get("database") or {}
        ports = services.get("ports") or {}
        if database.get("use_system_postgres") is True:
            database_url = "postgresql://postgres:postgres@localhost:5432/victoria"
        else:
            port = database.get("port") or ports.get("local_db")
            if not port:
                return None
            database_url = f"postgresql://postgres:postgres@localhost:{port}/victoria"
    else:
        # A shared run may leave its workspace-scoped Postgres alive after its
        # services manifest is removed. Isolated stacks replace the inherited
        # Conductor identity with their per-run identity, so derive the shared
        # container from the physical repository directory exactly as
        # scripts/lib/workspace-env.sh does. Never scan or guess another DB.
        container = f"victoria-db-{REPO_ROOT.name}"
        inspect = [
            "docker",
            "inspect",
            container,
            "--format",
            '{{.State.Running}} {{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
        ]
        try:
            result = subprocess.run(inspect, capture_output=True, text=True, timeout=5)
        except Exception:
            return None
        parts = result.stdout.strip().split()
        if result.returncode != 0 or len(parts) != 2 or parts[0].lower() != "true":
            return None
        try:
            port = int(parts[1])
        except ValueError:
            return None
        if not 1 <= port <= 65535:
            return None
        database_url = f"postgresql://postgres:postgres@localhost:{port}/victoria"

    usable_claude_query = f"""
        SELECT EXISTS (
          SELECT 1
          FROM "Integration"
          WHERE name = 'claude_code'
            AND status = 'CONNECTED'
            AND (
              "userId" = '{USER_ID}'
              OR "poolingEnabled" = TRUE
            )
            AND COALESCE(config->>'encryptedCredentials', '') <> ''
            AND ("rateLimitedUntil" IS NULL OR "rateLimitedUntil" < NOW())
        );
    """.strip()
    try:
        result = subprocess.run(
            ["psql", database_url, "-t", "-A", "-c", usable_claude_query],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    usable = result.returncode == 0 and result.stdout.strip().lower() in {"t", "true", "1"}
    return database_url if usable else None


def _database_endpoint_identity(database_url: str) -> Optional[tuple[str, int, str]]:
    """Return a normalized server/database identity without credentials or flags.

    This is deliberately conservative: callers use it to prove that a token
    source differs from a restored target.  An identity that cannot be parsed
    must therefore remain unknown rather than being treated as distinct.
    """
    try:
        parsed = urlparse(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            return None
        port = parsed.port or 5432
    except ValueError:
        return None
    host = unquote(parsed.hostname).lower().rstrip(".")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if address.is_loopback:
            host = "localhost"
        else:
            host = address.compressed

    database = unquote(parsed.path.lstrip("/"))
    if not database:
        return None
    return host, port, database


def _production_compute_token_database_url(local_database_url: str) -> Optional[str]:
    """Return the explicit production source used by cloud benchmark clones.

    Local isolated runs prefer the already-verified top-level workspace DB, but
    cloud clones do not have that second local service. Their decoded backend
    env is the only explicit source available to ``seed-local
    --compute-tokens-only``. Keep the source selection in Python so the seed
    command never falls back to an ambient ``DATABASE_URL`` that run.sh has
    overwritten with the isolated destination.
    """
    target_identity = _database_endpoint_identity(local_database_url)
    if target_identity is None:
        return None
    configured_url = (
        load_env_var("DATABASE_URL", _BACKEND_ENV, include_process_env=False)
        or load_env_var("DIRECT_URL", _BACKEND_ENV, include_process_env=False)
        or load_env_var("DIRECT_DATABASE_URL", _BACKEND_ENV, include_process_env=False)
    )
    if not configured_url:
        return None
    configured_identity = _database_endpoint_identity(configured_url)
    if not configured_identity or configured_identity == target_identity:
        return None
    # This URL is consumed by Prisma, not psql. Preserve its pooler contract
    # (`pgbouncer=true`, connection limits, etc.); stripping those parameters
    # makes Supabase's transaction pooler reject prepared statements (26000).
    return configured_url if not _database_urls_equivalent(configured_url, local_database_url) else None


def _compute_token_source_database_url(target_database_url: str) -> tuple[Optional[str], Optional[str]]:
    """Choose a distinct, credential-bearing source for compute-token refresh."""
    target_identity = _database_endpoint_identity(target_database_url)
    if target_identity is None:
        return None, None

    shared_source = _shared_workspace_database_url()
    shared_identity = _database_endpoint_identity(shared_source or "")
    if (
        shared_source
        and shared_identity
        and shared_identity != target_identity
        and not _database_urls_equivalent(shared_source, target_database_url)
    ):
        return shared_source, "shared workspace"

    configured_source = _production_compute_token_database_url(target_database_url)
    if configured_source:
        return configured_source, "prod"
    return None, None


def _psql_compatible_database_url(database_url: str) -> str:
    """Drop Prisma-only query params before passing a URL to the psql CLI."""
    parsed = urlparse(database_url)
    if not parsed.query:
        return database_url
    unsupported = {"pgbouncer", "connection_limit", "pool_timeout"}
    query = urlencode(
        [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key not in unsupported]
    )
    return urlunparse(parsed._replace(query=query))


def _database_urls_equivalent(left: str, right: str) -> bool:
    """Conservatively identify the same Postgres database across DSN options."""

    def identity(database_url: str) -> tuple:
        parsed = urlparse(database_url)
        scheme = "postgresql" if parsed.scheme in {"postgres", "postgresql"} else parsed.scheme
        port = parsed.port or (5432 if scheme == "postgresql" else None)
        return (
            scheme,
            (parsed.hostname or "").lower(),
            port,
            parsed.path or "/",
        )

    return identity(left) == identity(right)


# Docker Desktop's daemon socket briefly refuses connections while it reaps a
# previous run's containers, so a back-to-back benchmark can hit it mid-startup.
# That is infrastructure noise, not a benchmark result — retrying it is what
# stops a transient blip from being recorded as a task failure in the ledger.
_TRANSIENT_LOCAL_SQL_MARKERS = (
    "cannot connect to the docker daemon",
    "docker daemon is not running",
    "error during connect",
    "connection refused",
    "the database system is starting up",
    "server closed the connection unexpectedly",
)
_LOCAL_SQL_ATTEMPTS = 4
_LOCAL_SQL_RETRY_DELAY_SECONDS = 2.0


def _is_transient_local_sql_error(stderr: str) -> bool:
    lowered = stderr.lower()
    return any(marker in lowered for marker in _TRANSIENT_LOCAL_SQL_MARKERS)


def _run_local_victoria_sql(sql: str) -> str:
    last_error = ""
    for attempt in range(_LOCAL_SQL_ATTEMPTS):
        try:
            return _run_local_victoria_sql_once(sql)
        except RuntimeError as error:
            last_error = str(error)
            if not _is_transient_local_sql_error(last_error) or attempt == _LOCAL_SQL_ATTEMPTS - 1:
                raise
            print(
                f"    ⏳ Local DB unavailable (attempt {attempt + 1}/{_LOCAL_SQL_ATTEMPTS}), "
                f"retrying: {last_error[:120]}"
            )
            time.sleep(_LOCAL_SQL_RETRY_DELAY_SECONDS)
    raise RuntimeError(f"Local DB SQL failed: {last_error}")


def _run_local_victoria_sql_once(sql: str) -> str:
    container = _local_victoria_db_container()
    if container:
        result = subprocess.run(
            [
                "docker",
                "exec",
                container,
                "psql",
                "-U",
                "postgres",
                "-d",
                "victoria",
                "-t",
                "-A",
                "-F",
                "\t",
                "-c",
                sql,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
    else:
        database_url = _local_victoria_database_url()
        if not database_url:
            raise RuntimeError(
                "Local Victoria DB connection not found. Run this benchmark against the local stack "
                "from a Conductor workspace so minted-account cleanup can use the local DB."
            )
        result = subprocess.run(
            ["psql", database_url, "-t", "-A", "-F", "\t", "-c", sql],
            capture_output=True,
            text=True,
            timeout=15,
        )
    if result.returncode != 0:
        raise RuntimeError(f"Local DB SQL failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _is_local_base_url(base_url: str) -> bool:
    parsed = urlparse(base_url if base_url.startswith(("http://", "https://")) else f"http://{base_url}")
    return (parsed.hostname or "").lower() in {"localhost", "127.0.0.1"}


def _grep_base_snapshot_path() -> Path:
    configured = os.environ.get(GREP_BASE_SNAPSHOT_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    return REPO_ROOT / ".context" / "benchmarks" / "grep-base-snapshot.sql"


def _reads_base_trajectory_history(task: BenchmarkTask) -> bool:
    return BASE_TRAJECTORY_HISTORY_SOURCE in (getattr(task, "source", None) or [])


def _isolated_stack_database_url() -> Optional[str]:
    """Return the active per-run stack DB, never a workspace, shared or prod DB.

    Isolated means run.sh's per-run database: ``victoria_bench_<run>`` on system
    Postgres, or a Postgres server container run.sh created and owns for this run.
    """
    try:
        services = json.loads((_benchmark_context_path() / "services.json").read_text())
        if not isinstance(services, dict) or not _services_manifest_is_active(services):
            return None
        database = services.get("database")
        if not isinstance(database, dict):
            return None
        if database.get("use_system_postgres"):
            isolated = str(database.get("name") or "").startswith("victoria_bench_")
        else:
            isolated = database.get("owned_by_run_sh") is True and bool(database.get("container"))
        return manifest_database_url(services) if isolated else None
    except (OSError, ValueError):
        return None


def _restore_base_trajectory_history(batch_started_at: datetime) -> Optional[int]:
    """Drop trajectory-index rows this batch wrote; base-image rows predate it.

    Returns the number of removed rows, or None when no isolated stack DB is
    active (a reused or remote stack cannot be scoped this way).
    """
    database_url = _isolated_stack_database_url()
    if database_url is None:
        return None
    sql = (
        'WITH removed AS (DELETE FROM "AgentTrajectorySearch" '
        # createdAt is a UTC TIMESTAMP(3); compare in UTC regardless of server TimeZone.
        f'WHERE "createdAt" >= ({_sql_literal(batch_started_at.isoformat())}::timestamptz AT TIME ZONE \'UTC\') '
        "RETURNING 1) "
        "SELECT COUNT(*) FROM removed;"
    )
    result = subprocess.run(
        ["psql", database_url, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Trajectory history restore failed: {result.stderr.strip()}")
    return int(result.stdout.strip().splitlines()[-1])


def _prepare_base_trajectory_history(task: BenchmarkTask, base_url: str, batch_started_at: datetime) -> None:
    if not _reads_base_trajectory_history(task) or not _is_local_base_url(base_url):
        return
    removed = _restore_base_trajectory_history(batch_started_at)
    if removed is None:
        print(f"    ⚠ {task.name}: no isolated stack DB; earlier runs stay visible to trajectory recall")
    else:
        print(f"    🧹 {task.name}: restored base trajectory history ({removed} batch row(s) removed)")


def _run_local_db_process(args: List[str], *, stdin_path: Optional[Path] = None, timeout: int = 120) -> str:
    container = _local_victoria_db_container()
    if container:
        command = ["docker", "exec"]
        if stdin_path:
            command.append("-i")
        command.extend([container, *args])
    else:
        command = args

    stdin_handle = stdin_path.open("rb") if stdin_path else None
    try:
        result = subprocess.run(
            command,
            stdin=stdin_handle,
            capture_output=True,
            text=False,
            timeout=timeout,
        )
    finally:
        if stdin_handle:
            stdin_handle.close()
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Local DB command failed: {stderr}")
    return result.stdout.decode("utf-8", errors="replace")


def _ensure_grep_frozen_base_snapshot() -> Path:
    path = _grep_base_snapshot_path()
    if path.exists() and path.stat().st_size > 0:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    container = _local_victoria_db_container()
    if container:
        args = [
            "pg_dump",
            "-U",
            "postgres",
            "-d",
            "victoria",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
        ]
    else:
        database_url = _local_victoria_database_url()
        if not database_url:
            raise RuntimeError("Cannot create frozen grep benchmark DB snapshot: local Victoria DB not found")
        args = ["pg_dump", database_url, "--clean", "--if-exists", "--no-owner", "--no-privileges"]

    dump = _run_local_db_process(args, timeout=180)
    path.write_text(dump)
    print(f"    🧊 Created frozen grep DB snapshot: {path}")
    return path


def _restore_grep_frozen_base_snapshot() -> None:
    snapshot = _ensure_grep_frozen_base_snapshot()
    container = _local_victoria_db_container()
    if container:
        args = ["psql", "-U", "postgres", "-d", "victoria", "-v", "ON_ERROR_STOP=1"]
    else:
        database_url = _local_victoria_database_url()
        if not database_url:
            raise RuntimeError("Cannot restore frozen grep benchmark DB snapshot: local Victoria DB not found")
        args = ["psql", database_url, "-v", "ON_ERROR_STOP=1"]
    _run_local_db_process(args, stdin_path=snapshot, timeout=180)
    print(f"    🧊 Restored frozen grep DB snapshot: {snapshot}")


def _grep_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for grep benchmark fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = USER_ID
    return env


def _prod_source_database_url_for_fixture(target_database_url: str) -> Optional[str]:
    """Resolve a remote/prod DB URL for one-shot fixture freezes.

    Isolated local runs set process ``DATABASE_URL`` to the per-run Victoria
    database. Reading that process value as the freeze *source* makes
    ``source == target``, so ``BENCHMARK_*_SOURCE_DATABASE_URL`` is never set
    and a missing frozen fixture file fails closed with "no source URL".
    Always read the backend ``.env`` file (not process env), preferring
    direct URLs when present.
    """
    source_database_url = (
        load_env_var("DIRECT_URL", _BACKEND_ENV, include_process_env=False)
        or load_env_var("DIRECT_DATABASE_URL", _BACKEND_ENV, include_process_env=False)
        or load_env_var("DATABASE_URL", _BACKEND_ENV, include_process_env=False)
    )
    if not source_database_url:
        return None
    source_database_url = _psql_compatible_database_url(source_database_url)
    if source_database_url == target_database_url:
        return None
    return source_database_url


def _plaid_transactions_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for Plaid transaction benchmark fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = USER_ID
    source_database_url = _prod_source_database_url_for_fixture(database_url)
    if source_database_url:
        env["BENCHMARK_PLAID_SOURCE_DATABASE_URL"] = source_database_url
    return env


def _parse_last_json_line(stdout: str) -> dict:
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            continue
    return {}


_PLAID_TRANSACTIONS_FIXTURE_CACHE: dict[str, dict] = {}


def _run_plaid_transactions_fixture(action: str) -> dict:
    if action == "apply" and action in _PLAID_TRANSACTIONS_FIXTURE_CACHE:
        return dict(_PLAID_TRANSACTIONS_FIXTURE_CACHE[action])
    result = subprocess.run(
        ["npx", "tsx", "scripts/plaid-transactions-benchmark-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_plaid_transactions_fixture_env(),
        capture_output=True,
        text=True,
        timeout=240 if action == "sync-real" else 60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Plaid transaction benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}"
        )
    manifest = _parse_last_json_line(result.stdout)
    if action == "apply":
        _PLAID_TRANSACTIONS_FIXTURE_CACHE[action] = dict(manifest)
    elif action == "cleanup":
        _PLAID_TRANSACTIONS_FIXTURE_CACHE.clear()
    return manifest


def _plaid_transactions_fixture_action() -> str:
    mode = os.environ.get("BENCHMARK_PLAID_FIXTURE_MODE", "synthetic").strip().lower()
    if mode in ("", "real", "sync-real", "prod", "production"):
        return "sync-real"
    if mode in ("synthetic", "apply"):
        return "apply"
    raise RuntimeError("BENCHMARK_PLAID_FIXTURE_MODE must be one of real/sync-real/synthetic/apply")


def _user_data_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for user-data benchmark fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = USER_ID
    # Source (prod) URL lets the fixture freeze real documents once if the frozen
    # file is missing. When the frozen file already exists, apply is fully offline.
    source_database_url = _prod_source_database_url_for_fixture(database_url)
    if source_database_url:
        env["BENCHMARK_USER_DATA_SOURCE_DATABASE_URL"] = source_database_url
    return env


def _run_user_data_fixture(action: str) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/user-data-benchmark-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_user_data_fixture_env(),
        capture_output=True,
        text=True,
        timeout=240 if action in ("apply", "freeze") else 60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"user-data benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}")
    return _parse_last_json_line(result.stdout)


_GOOGLE_WORKSPACE_FIXTURE_CACHE: dict[str, dict] = {}


def _run_google_workspace_fixture(action: str) -> dict:
    """Seed (or remove) the frozen Google Calendar and Drive benchmark rows.

    Applied once per runner process: the tasks sharing this fixture run in
    parallel, and a second apply would delete and rewrite the rows while the
    first task's agent is already searching them.
    """
    if action == "apply" and action in _GOOGLE_WORKSPACE_FIXTURE_CACHE:
        return dict(_GOOGLE_WORKSPACE_FIXTURE_CACHE[action])
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for Google Workspace benchmark fixture")
    env = os.environ.copy()
    # The script refuses any non-local database: it replaces a user's synced
    # Calendar and Drive rows, which must never happen to production data.
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    env["BENCHMARK_USER_ID"] = USER_ID
    result = subprocess.run(
        ["npx", "tsx", "scripts/google-workspace-benchmark-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Google Workspace benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}"
        )
    manifest = _parse_last_json_line(result.stdout)
    if action == "apply":
        _GOOGLE_WORKSPACE_FIXTURE_CACHE[action] = dict(manifest)
    elif action == "cleanup":
        _GOOGLE_WORKSPACE_FIXTURE_CACHE.clear()
    return manifest


def _free_credit_subscription_fixture_env(user_id: Optional[str] = None) -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for free-credit subscription fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = user_id or _free_credit_subscription_gate_user_id()
    return env


def _run_free_credit_subscription_fixture(action: str, user_id: Optional[str] = None) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/free-credit-subscription-gate-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_free_credit_subscription_fixture_env(user_id),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"free-credit subscription benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}"
        )
    return _parse_last_json_line(result.stdout)


def _run_new_user_payment_fixture(user_id: Optional[str] = None) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/setup-benchmark-new-user-payment.ts"],
        cwd=REPO_ROOT / "back-end",
        env=_free_credit_subscription_fixture_env(user_id or _new_user_payment_journey_user_id()),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"new-user payment fixture failed: {(result.stderr or result.stdout).strip()}")
    return _parse_last_json_line(result.stdout)


async def _verify_new_user_payment_start_state(base_url: str, user_id: Optional[str] = None) -> None:
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base_url}/api/credits/usage",
            headers=headers,
            params={"userId": user_id or _new_user_payment_journey_user_id()},
        )
        response.raise_for_status()
        usage = response.json()
    if usage.get("remaining") != 0 or usage.get("tier") is not None or usage.get("unlimited") is not False:
        raise RuntimeError(f"New-user payment fixture did not start gated: {usage}")


def _gate_fixture_env(task_name: str) -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for gate benchmark fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_GATE_FIXTURE_MODE"] = GATE_FIXTURE_TASK_MODES[task_name]
    env["BENCHMARK_USER_ID"] = GATE_FIXTURE_TASK_USER_IDS[task_name]
    return env


def _run_gate_fixture(task_name: str, action: str) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/gate-benchmark-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_gate_fixture_env(task_name),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gate benchmark fixture {action} failed for {task_name}: {(result.stderr or result.stdout).strip()}"
        )
    return _parse_last_json_line(result.stdout)


def _run_subscription_webhook_resume_fixture(task_name: str) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/gate-subscription-webhook-fixture.ts"],
        cwd=REPO_ROOT / "back-end",
        env=_gate_fixture_env(task_name),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gate-subscription-webhook fixture failed for {task_name}: {(result.stderr or result.stdout).strip()}"
        )
    manifest = _parse_last_json_line(result.stdout)
    customer_id = str(manifest.get("stripe_customer_id") or "").strip()
    user_id = str(manifest.get("user_id") or "").strip()
    if customer_id == "" or user_id == "":
        raise RuntimeError(f"gate-subscription-webhook fixture returned incomplete manifest: {manifest}")
    _subscription_webhook_stripe_customers[user_id] = customer_id
    return manifest


def _seed_output_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value if isinstance(value, str) else ""


def _seed_sync_error_detail(result: object) -> str:
    """Render a failed seed-local subprocess's output without destroying the
    diagnosis. Prisma errors put the actual reason (error code / constraint /
    timeout) at the END of the message, after the invocation header — a naive
    head truncation reduced the 2026-07-18 claude-code-agent smoke failure to
    an unusable 'Invalid `localCookie.upsert()` invocation in <file>' stub.
    Keep the head for context and the tail for the root cause."""
    stderr = _seed_output_text(getattr(result, "stderr", None))
    stdout = _seed_output_text(getattr(result, "stdout", None) or getattr(result, "output", None))
    streams = []
    if stderr.strip():
        streams.append(f"[stderr]\n{stderr.strip()}")
    if stdout.strip():
        streams.append(f"[stdout]\n{stdout.strip()}")
    detail = "\n".join(streams)
    if len(detail) <= 1200:
        return detail
    return f"{detail[:300]}\n    … [{len(detail) - 1100} chars elided] …\n    {detail[-800:]}"


def _run_seed_subprocess(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None,
    timeout: float,
) -> "subprocess.CompletedProcess[str]":
    """Run a seed command in its own process group.

    ``npx`` launches a child Node process. Killing only the wrapper on timeout
    leaves that child syncing production credentials after the benchmark has
    already failed and teardown has begun. A dedicated session lets the timeout
    path terminate the complete seed tree and retain its partial diagnostics.
    """
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(
            exc.cmd,
            exc.timeout,
            output=stdout or exc.output,
            stderr=stderr or exc.stderr,
        ) from None
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


# Compute-token types this run's fixture withholds after every refresh. A run
# whose selected tasks all declare requires_claude_code holds no leasable GPT
# (Codex) credential, so its root cannot lease type=gpt and run Codex.
_withheld_compute_token_types: set[str] = set()


def _claude_code_only_run(tasks: Sequence["BenchmarkTask"]) -> bool:
    """True when every selected task declares requires_claude_code."""
    return bool(tasks) and all(getattr(task, "requires_claude_code", False) for task in tasks)


def _withhold_compute_credentials(database_url: str, token_type: str) -> bool:
    """Disconnect one compute-token type in the isolated benchmark DB."""
    name = {"gpt": "gpt_code", "claude": "claude_code"}[token_type]
    sql = f"UPDATE \"Integration\" SET status = 'NOT_CONNECTED' WHERE name = '{name}' AND status = 'CONNECTED'"
    try:
        result = subprocess.run(
            ["psql", database_url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as exc:
        print(f"    ⚠ Could not withhold {name} credentials: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Could not withhold {name} credentials: {result.stderr.strip()[:200]}")
        return False
    print(f"    🔒 Withheld {name} credentials: every selected task requires Claude Code")
    return True


def _sync_compute_tokens(
    *,
    tolerate_gpt_code_unavailable: bool = False,
    tolerate_claude_code_unavailable: bool = False,
    required_token_types: tuple[str, ...] | None = None,
    allow_missing_claude_for_non_claude_tasks: bool | None = None,
) -> bool:
    """Refresh the compute-token integrations (claude_code / gpt_code + pool)
    from the verified workspace DB into an isolated benchmark DB. When there is
    no separate workspace DB (for example, inside a Fly guest), explicitly use
    the credential-bearing DATABASE_URL from the injected backend dotenv file.
    Source and target must identify different databases: a restored target can
    contain fixture rows without any usable live compute credentials.
    Returns False on any failure so the live-fixture caller can fail closed.

    The tolerance flags set explicit seed opt-ins for providers whose runtime
    replacements have already been validated by the caller. Codex-dependent
    tasks keep their strict credential gate downstream. Missing Claude OAuth is
    tolerated only after the local backend confirms that the configured funded
    Anthropic API key is not on cooldown."""
    database_url = _local_victoria_database_url()
    if not database_url:
        print("    ⚠ Compute-token sync skipped: local Victoria DB not found")
        return False
    explicit_codex_auth = bool(os.environ.get("CODEX_AUTH_PATH"))
    if explicit_codex_auth and (urlparse(database_url).hostname or "").lower() not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise RuntimeError("Explicit Codex auth requires an isolated loopback database")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    # None preserves existing launcher-scoped AgentCard fixture/default calls.
    # Explicit run-level selection overrides ambient permission for strict tasks.
    if allow_missing_claude_for_non_claude_tasks is not None:
        env.pop("SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK", None)
        if allow_missing_claude_for_non_claude_tasks is True:
            env["SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK"] = "1"
    env.pop("SEED_ALLOW_MISSING_GPT_CODE", None)
    env.pop("SEED_ALLOW_MISSING_CLAUDE_CODE", None)
    env.pop("SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL", None)
    compute_token_source, source_label = _compute_token_source_database_url(database_url)
    if not compute_token_source:
        print("    ⚠ Compute-token sync skipped: no explicit source database distinct from the isolated target")
        return False
    env["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] = compute_token_source
    env.pop("SEED_ALLOW_MISSING_GPT_CODE", None)
    env.pop("SEED_ALLOW_MISSING_CLAUDE_CODE", None)
    env.pop("SEED_REQUIRE_COMPUTE_TOKEN_TYPES", None)
    if required_token_types is not None:
        env["SEED_REQUIRE_COMPUTE_TOKEN_TYPES"] = ",".join(required_token_types)
    if tolerate_gpt_code_unavailable:
        env["SEED_ALLOW_MISSING_GPT_CODE"] = "1"
    if tolerate_claude_code_unavailable:
        env["SEED_ALLOW_MISSING_CLAUDE_CODE"] = "1"
        # The running backend is the source of truth for fallback readiness,
        # and it accepts either its shared Anthropic key or the OpenRouter
        # Anthropic-compatible gateway.  ``--compute-tokens-only`` deliberately
        # does not load back-end/.env, so carry only those two already-configured
        # candidates into the seed subprocess.  Otherwise the backend can prove
        # OpenRouter ready while seed-local sees neither key and rejects the same
        # fallback contract before any benchmark agent is created.
        for fallback_env_name in ("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"):
            fallback_value = load_env_var(fallback_env_name, _BACKEND_ENV)
            if fallback_value:
                env[fallback_env_name] = fallback_value
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-local.ts", "--compute-tokens-only"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Compute-token sync timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Compute-token sync error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Compute-token sync failed: {_seed_sync_error_detail(result)}")
        return False
    print(f"    🔑 Refreshed compute tokens from {source_label}")
    if explicit_codex_auth and not _refresh_local_gpt_token_from_codex_auth(database_url):
        raise RuntimeError("Benchmark sync could not refresh GPT credentials from explicit Codex auth")
    for token_type in sorted(_withheld_compute_token_types - set(required_token_types or ())):
        if not _withhold_compute_credentials(database_url, token_type):
            return False
    return True


def _refresh_local_claude_token_from_keychain(database_url: str) -> bool:
    """Overlay this Mac's current Claude OAuth token onto the isolated DB.

    The shared workspace is a useful credential source, but its encrypted
    Claude row can still look usable after Anthropic has invalidated the OAuth
    token.  Local Claude Code owns the freshest renewable token in Keychain, so
    prefer it for Mac-hosted smoke runs after the ordinary source sync.  This is
    best-effort: hosts without that local credential retain the synced source.
    """
    if sys.platform != "darwin" or shutil.which("security") is None:
        return False
    decryption_key = load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", _BACKEND_ENV)
    if not decryption_key:
        print("    ⚠ Local Claude keychain refresh skipped: credential encryption key unavailable")
        return False

    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] = decryption_key
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-claude-code-token-from-keychain.ts"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Local Claude keychain refresh timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Local Claude keychain refresh error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Local Claude keychain refresh unavailable: {_seed_sync_error_detail(result)}")
        return False
    print("    🔑 Refreshed Claude credentials from macOS Keychain")
    return True


def _local_codex_auth_path() -> Path:
    """Where this machine's Codex/ChatGPT auth envelope lives, if it has one."""
    return Path(os.environ.get("CODEX_AUTH_PATH", Path.home() / ".codex" / "auth.json"))


def _refresh_local_gpt_token_from_codex_auth(database_url: str) -> bool:
    """Overlay explicit local or this Mac's ChatGPT/Codex token onto the isolated DB.

    The shared workspace copy can still look connected after OpenAI has
    invalidated its access token. Local Codex owns the freshest renewable auth
    envelope, so GPT-only local benchmark lanes must replace the copied row
    before agents start. The row stays owned by the dev user and is made
    pool-eligible only inside the isolated benchmark database.
    """
    explicit_auth = bool(os.environ.get("CODEX_AUTH_PATH"))
    if sys.platform != "darwin" and not explicit_auth:
        return False
    auth_path = _local_codex_auth_path()
    if explicit_auth:
        import stat

        if (urlparse(database_url).hostname or "").lower() not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Explicit Codex auth requires an isolated loopback database")
        try:
            metadata = auth_path.lstat()
            if (
                metadata.st_uid != os.geteuid()
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_mode & 0o077
                or not 0 < metadata.st_size <= 65536
            ):
                raise ValueError("invalid private auth file")
        except (OSError, ValueError) as exc:
            raise RuntimeError("Explicit Codex auth must be a nonempty private regular file") from exc
    if not auth_path.is_file():
        print(f"    ⚠ Local Codex refresh skipped: auth file unavailable at {auth_path}")
        return False
    decryption_key = load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", _BACKEND_ENV)
    if not decryption_key:
        print("    ⚠ Local Codex refresh skipped: credential encryption key unavailable")
        return False

    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] = decryption_key
    env["CODEX_AUTH_PATH"] = str(auth_path)
    env["CODEX_TOKEN_POOLING_ENABLED"] = "true"
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/sync-codex-token.ts"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Local Codex refresh timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Local Codex refresh error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Local Codex refresh unavailable: {_seed_sync_error_detail(result)}")
        return False
    print("    🔑 Refreshed GPT credentials from local Codex auth")
    return True


def _sync_browser_credentials(
    cookie_domains: tuple[str, ...] = (),
    *,
    user_id: Optional[str] = None,
) -> bool:
    """Refresh the complete live browser auth graph (context/provider profiles,
    cookies/storage, CookieBundles, Steel sessions, passwords, and passkeys) from
    prod into the isolated benchmark DB. Same pattern as
    _sync_compute_tokens: a one-time setup-db sync goes stale as cookies expire,
    so the live fixture re-pulls them right before the agent starts.
    Best-effort but loud. Reads the prod source from back-end/.env.

    ``user_id`` retargets the sync at a real production identity other than the
    default benchmark user. The seed upserts that User row before writing any
    browser-auth rows, so an isolated DB can safely run the task as that person.

    When ``cookie_domains`` is given (from the task's environment.live_cookie_domains),
    every domain-bearing browser-auth table is scoped to those domains: cookies,
    bundles, origin storage, permissions, passwords, Steel sessions, and passkeys.
    A task that only needs e.g. doordash.com therefore avoids both the full ~22k
    cookie graph and thousands of unrelated durable-auth rows. With no domains
    declared it syncs the full graph under a raised budget (generic tasks pay the
    honest cost)."""
    database_url = _local_victoria_database_url()
    if not database_url:
        print("    ⚠ Credential sync skipped: local Victoria DB not found")
        return False
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    if user_id:
        env["SEED_LOCAL_USER_ID"] = user_id
    if cookie_domains:
        # seed-local.ts filters every domain-bearing browser-auth read, so the
        # sync is bounded by the task's auth state, not the whole account.
        env["SEED_COOKIE_DOMAINS"] = ",".join(cookie_domains)
        cred_timeout = 300
        print(f"    🍪 scoping browser-credential sync to {len(cookie_domains)} domain(s): {', '.join(cookie_domains)}")
    else:
        # No declared domains → full browser-auth graph. It legitimately takes several
        # minutes on a warm box (which skipped run.sh's boot sync), so give it the
        # honest budget instead of failing the whole task at 420s.
        cred_timeout = 900
        print("    🍪 full browser-credential sync (no live_cookie_domains) — raised budget")
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-local.ts", "--credentials-only"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            # A scoped sync takes seconds; the full graph takes minutes. seed-local
            # retries transient DB failures up to 3x internally, so the budget must
            # cover multiple attempts of whichever mode this is.
            timeout=cred_timeout,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Credential sync timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Credential sync error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Credential sync failed: {_seed_sync_error_detail(result)}")
        return False
    print("    🍪 Refreshed complete browser auth state from prod")
    return True


def _sync_email_credentials() -> bool:
    """Refresh Gmail/Yahoo integration rows + EmailIntegrationCredential from prod.

    The canonical base-image dump can freeze abandoned OAuth rows (null email /
    null accessToken). Connected Integrations then omits every send-from address
    and ``message_person`` fails closed with ``Missing from_email`` before any
    email_send approval can fire. Same pattern as ``_sync_compute_tokens``.
    """
    database_url = _local_victoria_database_url()
    if not database_url:
        print("    ⚠ Email credential sync skipped: local Victoria DB not found")
        return False
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-local.ts", "--email-credentials-only"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Email credential sync timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Email credential sync error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Email credential sync failed: {_seed_sync_error_detail(result)}")
        return False
    print("    ✉️  Refreshed email credentials from prod")
    return True


def _sync_passkeys(
    *,
    user_id: Optional[str] = None,
    cookie_domains: tuple[str, ...] = (),
) -> None:
    """Refresh only passkeys from prod into the isolated benchmark DB.

    Unlike the broad base fixture, this deliberately excludes cookies, origin
    storage, browser profiles, and passwords. Failure is fatal because an old
    or missing passkey would invalidate the benchmark rather than merely make
    it less convenient.

    ``user_id`` retargets the seed at another real production identity (and
    makes it upsert that User row first, so later user-scoped writes have a
    parent). Default None keeps the dev user, which is what every existing
    caller wants. ``cookie_domains`` scopes the passkey selection to the realms
    a task actually needs.
    """
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for passkey-only sync")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    if user_id:
        env["SEED_LOCAL_USER_ID"] = user_id
    if cookie_domains:
        env["SEED_COOKIE_DOMAINS"] = ",".join(cookie_domains)
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-local.ts", "--passkeys-only"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Passkey-only sync timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}") from exc
    except Exception as exc:
        raise RuntimeError(f"Passkey-only sync failed: {exc}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"Passkey-only sync failed: {_seed_sync_error_detail(result)}")
    print("    🔐 Refreshed passkeys only from prod")


@dataclass
class LiveFixtureContext:
    """Runtime inputs handed to a live-fixture applier."""

    base_url: str
    user_id: str
    auth_realm: str
    # When a task declares environment.live_cookie_domains, the browser-credential
    # sync is scoped to just those cookie domains (seconds, not ~13 min). Empty →
    # full cookie sync with a raised budget.
    cookie_domains: tuple[str, ...] = ()
    # Only these scoped domains require an injectable CookieBundle at dispatch.
    # Guest-checkout tasks still scope their sync via cookie_domains, but an
    # absent CookieBundle must not prevent them from reaching the public flow.
    required_injectable_cookie_domains: tuple[str, ...] = ()
    tolerate_claude_code_unavailable: bool = False


def _is_simulate_mode() -> bool:
    """True when this run's tool execution is served by the World Model Harness.
    Set once at startup (BENCHMARK_WORLD_MODEL_MODE, run_benchmark.py:478)."""
    return os.environ.get("BENCHMARK_WORLD_MODEL_MODE") == "simulate"


def _anthropic_family_excluded() -> bool:
    return os.getenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


# Chrome/WebKit cookie timestamps count microseconds from 1601-01-01; the offset
# to the unix epoch matches back-end/src/providers/steel/injection.ts.
_CHROME_EPOCH_OFFSET_SECONDS = 11644473600


def _live_cookie_domain_credential_summary(user_id: str, domain: str) -> dict:
    """Count the browser credentials the injection path could actually consume.

    This mirrors back-end/src/providers/steel/injection.ts exactly:
    ``selectTopCookieBundle`` only returns a ``CookieBundle`` that is enabled AND
    holds at least one ``Cookie`` row in the same (browserSource, browserProfile)
    whose domain satisfies ``cookieDomainWhere(authRealm)`` — an enabled marker
    with no matching cookie row "is not an authentication source". Loose cookie
    rows with no bundle are never injected, because selection is bundle-keyed.

    ``SteelSessionAuth`` is counted for diagnostics but is NOT treated as proof of
    provisioning: ``resolveBrowserAuthCredentialSource`` only prefers that marker
    when the LIVE Steel session already carries unexpired realm cookies
    (``steelSessionHasRealmCookies !== false``), and otherwise logs "Steel auth
    marker exists but current session has no realm cookies" and falls through to
    the CookieBundle. That liveness is runtime state no pre-flight can observe —
    no session exists yet — so the DB-verifiable requirement injection lands on is
    the bundle.

    Realm scoping matches back-end/scripts/cookie-domain-scope.ts
    ``authRealmSyncWhere``/``cookieSyncWhere`` (exact host, leading-dot host, or a
    dot-boundary subdomain) so the preflight asks about precisely the rows the
    scoped sync was asked to deliver.

    Expiry is reported but deliberately NOT part of the predicate: injection maps
    an already-expired ``expiresUtc`` to ``undefined`` and still injects the
    cookie as a session cookie, so treating expiry as disqualifying would be
    stricter than the code under test.
    """
    normalized = domain.strip().lower()
    user = _sql_literal(user_id)
    target = _sql_literal(normalized)
    sql = f"""
WITH bundles AS (
    SELECT b.id,
           b."browserSource",
           b."browserProfile",
           b."disabledAt",
           regexp_replace(lower(btrim(b."authRealm")), '^\\.+', '') AS realm
    FROM "CookieBundle" b
    WHERE b."userId" = {user}
      AND (
        lower(btrim(b."authRealm")) = {target}
        OR lower(btrim(b."authRealm")) = '.' || {target}
        OR right(lower(btrim(b."authRealm")), length({target}) + 1) = '.' || {target}
      )
),
bundle_realms AS (
    SELECT bundles.*,
           CASE WHEN left(realm, 4) = 'www.' THEN substr(realm, 5) ELSE realm END AS parent_realm
    FROM bundles
),
injectable AS (
    SELECT r.id
    FROM bundle_realms r
    WHERE r."disabledAt" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "Cookie" c
        WHERE c."userId" = {user}
          AND c."browserSource" = r."browserSource"
          AND c."browserProfile" = r."browserProfile"
          AND (
            lower(c.domain) IN (r.realm, '.' || r.realm, r.parent_realm, '.' || r.parent_realm)
            OR right(lower(c.domain), length(r.realm) + 1) = '.' || r.realm
            OR right(lower(c.domain), length(r.parent_realm) + 1) = '.' || r.parent_realm
          )
      )
),
domain_cookies AS (
    SELECT c."expiresUtc", c."syncedAt"
    FROM "Cookie" c
    WHERE c."userId" = {user}
      AND (
        lower(c.domain) = {target}
        OR lower(c.domain) = '.' || {target}
        OR right(lower(c.domain), length({target}) + 1) = '.' || {target}
      )
),
steel AS (
    SELECT s.id
    FROM "SteelSessionAuth" s
    WHERE s."userId" = {user}
      AND s."disabledAt" IS NULL
      AND (
        lower(btrim(s."authRealm")) = {target}
        OR lower(btrim(s."authRealm")) = '.' || {target}
        OR right(lower(btrim(s."authRealm")), length({target}) + 1) = '.' || {target}
      )
)
SELECT json_build_object(
    'domain', {target},
    'bundles_total', (SELECT count(*) FROM bundle_realms),
    'bundles_enabled', (SELECT count(*) FROM bundle_realms WHERE "disabledAt" IS NULL),
    'bundles_injectable', (SELECT count(*) FROM injectable),
    'steel_sessions_enabled', (SELECT count(*) FROM steel),
    'cookies_total', (SELECT count(*) FROM domain_cookies),
    'cookies_unexpired', (
        SELECT count(*) FROM domain_cookies
        WHERE "expiresUtc" IS NULL
           OR "expiresUtc" <= 0
           OR ("expiresUtc" / 1000000 - {_CHROME_EPOCH_OFFSET_SECONDS}) > extract(epoch FROM now())
    ),
    'newest_cookie_synced_at', (
        SELECT to_char(max("syncedAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        FROM domain_cookies
    )
)::text;
""".strip()
    return json.loads(_run_local_victoria_sql(sql).strip())


def _live_cookie_domain_is_usable(summary: dict) -> bool:
    """A domain is provisioned when selectTopCookieBundle would return a bundle."""
    return int(summary.get("bundles_injectable") or 0) > 0


def _describe_unusable_cookie_domain(summary: dict) -> str:
    """Counts, domains, and timestamps only — never cookie values or tokens."""
    return (
        f"{summary.get('domain')}: "
        f"{summary.get('bundles_total') or 0} CookieBundle row(s) "
        f"({summary.get('bundles_enabled') or 0} enabled, "
        f"{summary.get('bundles_injectable') or 0} with matching cookie rows), "
        f"{summary.get('steel_sessions_enabled') or 0} enabled SteelSessionAuth marker(s) "
        "(not injectable on their own), "
        f"{summary.get('cookies_total') or 0} cookie row(s) "
        f"({summary.get('cookies_unexpired') or 0} unexpired), "
        f"newest cookie syncedAt={summary.get('newest_cookie_synced_at') or 'never'}"
    )


def _task_needs_auth(task: "BenchmarkTask") -> bool:
    """True when the catalog declares environment.needs_auth (live session required)."""
    return bool((task.environment or {}).get("needs_auth"))


def _needs_auth_domains(task: "BenchmarkTask") -> tuple[str, ...]:
    env = task.environment or {}
    raw = env.get("required_injectable_cookie_domains") or env.get("live_cookie_domains") or []
    return tuple(str(d).strip() for d in raw if str(d).strip())


def _looks_like_auth_session_failure(
    failure_reason: Optional[str],
    data: Optional[dict] = None,
) -> bool:
    """Detect auth-assistance / dead-session outcomes that needs_auth benches care about."""
    text = (failure_reason or "").lower()
    if any(
        marker in text
        for marker in (
            "auth_assistance",
            "awaiting_auth_assistance",
            "auth_failed",
            "valid auth token",
        )
    ):
        return True
    if not data:
        return False
    benchmark = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    if benchmark.get("unexpected_attention_kind") == "auth_assistance":
        return True
    if benchmark.get("attention_request_kind_seen") == "auth_assistance":
        return True
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    status = str(agent.get("status") or "").lower()
    return status in {"awaiting_auth_assistance", "auth_failed"}


def _annotate_needs_auth_failure(
    task: "BenchmarkTask",
    failure_reason: Optional[str],
    data: Optional[dict] = None,
) -> Optional[str]:
    """Rewrite auth-session failures on needs_auth benches into an INFRA/fixture report.

    Diagram::

        catalog needs_auth=true
                │
                ▼
        injectable cookies present? ──no──► preflight INFRA (existing)
                │ yes
                ▼
        live session valid? ──no──► auth_assistance / auth_failed
                │                      │
                │                      ▼
                │            annotate: "bench needs a valid auth token"
                ▼
              write_lock / task success

    Injectable CookieBundles prove selection, not liveness. When a needs_auth
    bench still lands on auth_assistance, report that the fixture needs a valid
    auth token rather than leaving a bare attention-kind mismatch.
    """
    if not failure_reason or not _task_needs_auth(task):
        return failure_reason
    if not _looks_like_auth_session_failure(failure_reason, data):
        return failure_reason
    if "needs a valid auth token" in failure_reason.lower():
        if data is not None:
            data["_benchmark"] = {
                **(data.get("_benchmark") or {}),
                "needs_auth": True,
                "auth_fixture_failure": True,
            }
        return failure_reason
    domains = _needs_auth_domains(task)
    domain_hint = f" for {', '.join(domains)}" if domains else ""
    annotated = (
        f"INFRA/fixture: this bench declares needs_auth and needs a valid auth token"
        f"{domain_hint} (injectable CookieBundles alone are insufficient — refresh a "
        f"live signed-in session for the fixture identity, re-sync, then re-run). "
        f"{failure_reason}"
    )
    if data is not None:
        data["_benchmark"] = {
            **(data.get("_benchmark") or {}),
            "needs_auth": True,
            "auth_fixture_failure": True,
        }
    return annotated


def _assert_live_cookie_domains_usable(user_id: str, cookie_domains: tuple[str, ...]) -> None:
    """Fail the fixture — loudly, as infra — when the scoped sync produced nothing usable.

    ``_sync_browser_credentials`` only reports whether the sync COMMAND succeeded.
    A domain whose prod auth is stale/orphaned (cookies present, but zero
    CookieBundle rows) syncs "successfully" and injects nothing, so the agent runs
    signed-out for the full task budget and gets scored as a capability failure.
    """
    if not cookie_domains:
        return
    summaries = [_live_cookie_domain_credential_summary(user_id, domain) for domain in cookie_domains]
    unusable = [s for s in summaries if not _live_cookie_domain_is_usable(s)]
    if not unusable:
        for summary in summaries:
            print(
                f"    🍪 {summary.get('domain')}: {summary.get('bundles_injectable')} injectable CookieBundle(s), "
                f"{summary.get('steel_sessions_enabled')} Steel session(s), "
                f"{summary.get('cookies_total')} cookie row(s)"
            )
        return
    names = ", ".join(str(s.get("domain")) for s in unusable)
    details = " | ".join(_describe_unusable_cookie_domain(s) for s in unusable)
    actions = "; ".join(
        f"log into {s.get('domain')} in a currently-syncing browser profile so the mac-app sync uploads a fresh bundle"
        for s in unusable
    )
    raise RuntimeError(
        f"Live fixture preflight: no injectable browser credential for {names} after the scoped "
        f"browser-credential sync. {details}. Cookie injection is bundle-keyed "
        "(back-end/src/providers/steel/injection.ts selects one enabled CookieBundle that has matching "
        "cookie rows, or an enabled SteelSessionAuth), so this task would run signed-out and be misscored "
        f"as an agent capability failure. This is an INFRA/fixture failure, not a task result. Fix: {actions}, "
        "then re-run. (An enabled SteelSessionAuth marker does not count: injection discards it whenever the "
        "live session carries no realm cookies and falls through to the CookieBundle.)"
    )


def _apply_live_fixture(ctx: LiveFixtureContext) -> dict:
    """Apply the one complete, current production-credential overlay.

    Simulation skips the overlay as a unit. Applying only compute tokens while
    omitting browser auth made the old ``base`` fixture neither reproducible nor
    truthful, and allowed later site-specific fixtures to fail before an agent
    was created.

    ``tolerate_gpt_code_unavailable=True`` matches the run-level pre-flight
    (``_refresh_local_compute_tokens_for_run``): prod can have zero *bench-usable*
    gpt_code (Codex) integrations (the usable rows are non-DEV / pooling-off, or
    Codex is quota-blocked). The live-mode tasks that take this overlay (browser,
    payment) do not spawn Codex, so gating them on gpt_code is a FALSE infra
    failure. When Anthropic is excluded, their ordinary root/browser turns still
    use the GPT-family provider waterfall (including OpenRouter); that is distinct
    from requiring a gpt_code integration for a Codex sandbox. A genuinely
    Codex-dependent task still fails at its own strict credential gate.
    """
    if _is_simulate_mode():
        print("    🌍 simulate mode — skipping the live credential overlay")
        return {"fixture": "live", "skipped": True, "reason": "simulate"}
    # Tolerate a quota-blocked Codex (gpt_code) exactly like the blanket pre-flight
    # (_refresh_local_compute_tokens_for_run): the live overlay serves browser/
    # credential tasks whose agents drive claude_code, so a rate-limited gpt_code
    # ("No usable gpt_code integrations after sync") must not fail closed here and
    # abort the whole run before an agent is ever created. Codex-dependent tasks
    # keep their own strict credential gates downstream. Without this, an exhausted
    # org-wide Codex quota failed every browser task at the fixture (0/8 ecommerce).
    if _anthropic_family_excluded():
        synced_compute_tokens = _sync_compute_tokens(
            tolerate_gpt_code_unavailable=True,
            required_token_types=("gpt",),
        )
    else:
        synced_compute_tokens = _sync_compute_tokens(
            tolerate_gpt_code_unavailable=True,
            tolerate_claude_code_unavailable=ctx.tolerate_claude_code_unavailable,
        )
    if not synced_compute_tokens:
        raise RuntimeError("Live fixture could not refresh compute tokens")
    if not _sync_email_credentials():
        raise RuntimeError("Live fixture could not refresh email credentials")
    if not _sync_browser_credentials(ctx.cookie_domains, user_id=ctx.user_id):
        raise RuntimeError("Live fixture could not refresh complete browser auth state")
    # A green sync only proves the command exited 0. For domains whose task
    # contract explicitly requires authentication, assert that the post-sync DB
    # holds a credential the injection path can select. live_cookie_domains alone
    # is a performance scope and may describe a valid guest-checkout task.
    _assert_live_cookie_domains_usable(ctx.user_id, ctx.required_injectable_cookie_domains)
    return {"fixture": "live", "browser_auth": True, "source": "prod_sync"}


def _require_compute_tokens_enabled() -> bool:
    """Opt-in cost gate: abort local benches when no direct compute path is usable.

    When set, the harness refuses to start agents that would fall through to the
    paid OpenRouter waterfall (claudeAuth/gptAuth unavailable or rate-limited).
    Descend and other cost-capped runs set ``BENCHMARK_REQUIRE_COMPUTE_TOKENS=1``.
    """
    return os.environ.get("BENCHMARK_REQUIRE_COMPUTE_TOKENS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _local_db_has_usable_direct_compute_token() -> bool:
    """True when the isolated DB holds a non-rate-limited direct compute credential.

    Mirrors the selection filters used by compute-token fetch: CONNECTED + active +
    encrypted credentials present + ``rateLimitedUntil`` null/past + empty
    ``failureReason``, for either ``claude_code`` or ``gpt_code`` (user-owned or
    pooling-enabled).

    ``failureReason='auth_error'`` must NOT count as usable: those rows are still
    ``CONNECTED`` in the DB after a failed refresh, and treating them as healthy
    lets ``BENCHMARK_REQUIRE_COMPUTE_TOKENS=1`` pass then fall through to the
    paid OpenRouter waterfall (descend-daily e2-preflight 2026-08-31).
    """
    if not _local_victoria_database_url():
        return False
    user = _sql_literal(USER_ID)
    usable_query = f"""
        SELECT EXISTS (
          SELECT 1
          FROM "Integration"
          WHERE name IN ('claude_code', 'gpt_code')
            AND status = 'CONNECTED'
            AND "isActive" = TRUE
            AND COALESCE(config->>'encryptedCredentials', '') <> ''
            AND ("rateLimitedUntil" IS NULL OR "rateLimitedUntil" < NOW())
            AND COALESCE("failureReason", '') = ''
            AND (
              "poolingEnabled" = TRUE
              OR "userId" = {user}
            )
        );
    """.strip()
    try:
        result = _run_local_victoria_sql(usable_query)
    except Exception as error:
        print(f"    ⚠️  Could not query usable compute tokens: {error}")
        return False
    return result.splitlines()[-1].strip().lower() in {"t", "true", "1"}


def _assert_require_compute_tokens_satisfied() -> None:
    """Fail closed when the cost gate is on and no direct compute path is usable."""
    if not _require_compute_tokens_enabled():
        return
    if _local_db_has_usable_direct_compute_token():
        return
    raise RuntimeError(
        "BENCHMARK_REQUIRE_COMPUTE_TOKENS=1 but no usable direct compute token "
        "(claude_code/gpt_code CONNECTED, active, not rate-limited). "
        "Refusing to start agents that would bill the paid waterfall — wait for "
        "compute to recover or replenish the pool."
    )


async def _refresh_local_compute_tokens_for_run(
    base_url: str,
    *,
    require_claude_code: bool = False,
    tasks: Sequence["BenchmarkTask"] = (),
) -> None:
    """Refresh agent-infrastructure compute credentials once before local tasks.

    Real local tasks refresh from the verified shared workspace. Simulated cloud
    stacks already restore the canonical base fixture and deliberately have no
    second source DB endpoint, so they use that restored credential state.

    When ``require_claude_code`` is set (the run includes tasks with
    ``requires_claude_code``), never tolerate a missing claude_code sync just
    because the shared Anthropic API-key fallback looks healthy — that path
    made cloud guests print "Refreshed compute tokens" then skip
    image-handling / files-in-sub-agents, which fleet then counted as PASS via
    ``--allow-claude-code-credential-skip``.
    """
    if not _is_local_base_url(base_url):
        return
    claude_code_only = _claude_code_only_run(tasks)
    require_claude_code = require_claude_code or claude_code_only
    _withheld_compute_token_types.clear()
    if claude_code_only:
        _withheld_compute_token_types.add("gpt")
    if _is_simulate_mode():
        print("    🌍 simulate mode — using compute tokens from the restored seed DB")
        database_url = _local_victoria_database_url()
        if claude_code_only and not (database_url and _withhold_compute_credentials(database_url, "gpt")):
            raise RuntimeError("Benchmark run could not withhold GPT credentials for Claude Code tasks")
        return
    if _anthropic_family_excluded():
        if require_claude_code:
            raise RuntimeError("Claude Code tasks cannot run when ROSE_EXCLUDE_ANTHROPIC_FAMILY is set")
        if not _sync_compute_tokens(
            tolerate_gpt_code_unavailable=True,
            required_token_types=("gpt",),
        ):
            raise RuntimeError("Benchmark run could not refresh local compute tokens")
        database_url = _local_victoria_database_url()
        if not database_url:
            raise RuntimeError("Benchmark run could not resolve the isolated benchmark database")
        # Overlaying this machine's Codex auth is an OPTIONAL freshness upgrade,
        # not a precondition. `_sync_compute_tokens` above already required and
        # obtained a gpt token from the verified shared workspace, so a machine
        # with no Codex login at all is a local-setup absence, not evidence that
        # the synced token is stale. Hard-failing there made an unrelated gate
        # (e.g. the AgentCard payment lifecycle, which needs no Codex at all)
        # unrunnable on any machine without `codex login`.
        #
        # A codex auth file that EXISTS but cannot be overlaid is still fatal:
        # that is the stale/rotated-token signal this overlay was built to catch.
        if (
            not os.environ.get("CODEX_AUTH_PATH")
            and _local_codex_auth_path().is_file()
            and not _refresh_local_gpt_token_from_codex_auth(database_url)
        ):
            raise RuntimeError("Benchmark run could not refresh GPT credentials from local Codex auth")
        _assert_require_compute_tokens_satisfied()
        return
    # Blanket pre-flight: the agent runtime uses claude_code, so a quota-blocked
    # Codex (gpt_code) must not fail the whole run when claude_code is healthy.
    # Codex-dependent tasks keep their own strict credential gates downstream.
    #
    # Claude Code sessions DO use the shared ANTHROPIC_API_KEY when no OAuth
    # envelope is available (see resolveClaudeCodeAuthEnvs). Tolerate a missing
    # claude_code sync only when that funded-key path is confirmed healthy —
    # otherwise require_claude_code tasks would start, discover an unfunded key
    # mid-run, and burn the suite. Never pair this with credential-skip-as-PASS.
    #
    # Code-agent tasks (requires_claude_code) can also run via Codex: the
    # spawn_claude_code_agent tool selects provider=codex when the workflow holds
    # a GPT compute token. Without a funded Anthropic key, require *either*
    # claude_code or gpt_code rather than hard-requiring Claude OAuth alone.
    has_anthropic_key_fallback = await _has_usable_anthropic_api_key_fallback(base_url)
    tolerate_missing_claude = has_anthropic_key_fallback
    required_token_types: tuple[str, ...] | None = None
    if require_claude_code and not has_anthropic_key_fallback:
        # A Claude-only run cannot fall back to Codex: its GPT credentials are withheld.
        required_token_types = ("claude",) if claude_code_only else ("any",)
        tolerate_missing_claude = False
    if not _sync_compute_tokens(
        tolerate_gpt_code_unavailable=True,
        tolerate_claude_code_unavailable=tolerate_missing_claude,
        required_token_types=required_token_types,
        allow_missing_claude_for_non_claude_tasks=(
            bool(tasks) and not require_claude_code
            and all(task.requires_claude_code is False for task in tasks)
        ),
    ):
        raise RuntimeError("Benchmark run could not refresh local compute tokens")
    if not has_anthropic_key_fallback:
        print(
            "    ⚠️  No claudeAuth compute path (expired/rate-limited claude_code and no funded "
            "Anthropic key): this run bills the paid waterfall. Cost figures are NOT comparable "
            "to a token-backed run."
        )
    database_url = _local_victoria_database_url()
    if database_url:
        _refresh_local_claude_token_from_keychain(database_url)
    _assert_require_compute_tokens_satisfied()


def _snapshot_browser_state(ctx: LiveFixtureContext, *, include_passwords: bool) -> dict:
    """Capture the shared browser rows needed to reverse an isolated scenario."""
    user = _sql_literal(ctx.user_id)
    realm = _sql_literal(ctx.auth_realm)
    password_snapshot = (
        'COALESCE((SELECT json_agg(id) FROM "BrowserPassword" '
        f'WHERE "userId" = {user} AND "disabledAt" IS NULL), \'[]\'::json)'
        if include_passwords
        else "'[]'::json"
    )
    snapshot_sql = (
        "SELECT json_build_object("
        "'steel_ids', COALESCE((SELECT json_agg(id) FROM \"SteelSessionAuth\" "
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL), \'[]\'::json), '
        "'bundle_ids', COALESCE((SELECT json_agg(id) FROM \"CookieBundle\" "
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL), \'[]\'::json), '
        f"'password_ids', {password_snapshot}, "
        "'profiles', COALESCE((SELECT json_agg(row_to_json(profile)) "
        'FROM "BrowserProviderProfile" profile JOIN "BrowserContext" context '
        'ON context.id = profile."contextId" '
        f"WHERE context.\"userId\" = {user} AND profile.provider = 'kernel'), '[]'::json)"
        ")::text;"
    )
    return json.loads(_run_local_victoria_sql(snapshot_sql))


def _clear_browser_state(
    ctx: LiveFixtureContext,
    *,
    disable_passwords: bool,
    disabled_reason: str,
) -> int:
    """Disable saved auth and remove persistent state before a fresh browser run."""
    user = _sql_literal(ctx.user_id)
    realm = _sql_literal(ctx.auth_realm)
    reason = _sql_literal(disabled_reason)
    ctes = [
        'steel AS (UPDATE "SteelSessionAuth" SET "disabledAt" = NOW(), '
        f'"disabledReason" = {reason} WHERE "userId" = {user} '
        f'AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id)',
        'bundles AS (UPDATE "CookieBundle" SET "disabledAt" = NOW(), '
        f'"disabledReason" = {reason} WHERE "userId" = {user} '
        f'AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id)',
    ]
    if disable_passwords:
        ctes.append(
            'passwords AS (UPDATE "BrowserPassword" SET "disabledAt" = NOW(), '
            f'"disabledReason" = {reason} WHERE "userId" = {user} '
            'AND "disabledAt" IS NULL RETURNING id)'
        )
    ctes.extend(
        [
            f'cookies AS (DELETE FROM "Cookie" WHERE "userId" = {user} RETURNING id)',
            f'local_storage AS (DELETE FROM "LocalStorageOrigin" WHERE "userId" = {user} RETURNING id)',
            f'indexed_db AS (DELETE FROM "IndexedDBOrigin" WHERE "userId" = {user} RETURNING id)',
            f'cache_storage AS (DELETE FROM "CacheStorageOrigin" WHERE "userId" = {user} RETURNING id)',
            f'permissions AS (DELETE FROM "BrowserPermission" WHERE "userId" = {user} RETURNING id)',
            'profiles AS (DELETE FROM "BrowserProviderProfile" profile USING "BrowserContext" context '
            f'WHERE profile."contextId" = context.id AND context."userId" = {user} '
            "AND profile.provider = 'kernel' RETURNING profile.id)",
        ]
    )
    cleanup_sql = (
        "WITH " + ", ".join(ctes) + " SELECT (SELECT COUNT(*) FROM cookies) + (SELECT COUNT(*) FROM local_storage) + "
        "(SELECT COUNT(*) FROM indexed_db) + (SELECT COUNT(*) FROM cache_storage) + "
        "(SELECT COUNT(*) FROM permissions) + (SELECT COUNT(*) FROM profiles);"
    )
    return int(_run_local_victoria_sql(cleanup_sql).splitlines()[-1].strip() or "0")


def _apply_amazon_passkey_scenario(ctx: LiveFixtureContext) -> dict:
    """Apply the task-specific destructive isolation for the passkey probe.

    This is scenario setup, not a reusable live fixture: the generic ``live``
    overlay first refreshes every credential class, then this one benchmark
    removes competing auth paths so it can prove passkey injection.
    """
    _sync_passkeys()

    user = _sql_literal(ctx.user_id)
    realm = _sql_literal(ctx.auth_realm)
    snapshot = _snapshot_browser_state(ctx, include_passwords=True)
    passkey_sql = (
        'SELECT COUNT(*) FROM "PasskeyCredential" '
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL;'
    )
    passkey_count = int(_run_local_victoria_sql(passkey_sql).splitlines()[-1].strip() or "0")
    if passkey_count <= 0:
        raise RuntimeError(f"No enabled passkey found for {ctx.auth_realm}")

    cleared = _clear_browser_state(
        ctx,
        disable_passwords=True,
        disabled_reason="disabled by passkey-only benchmark scenario",
    )
    print(f"    🔐 Prepared {passkey_count} Amazon passkey(s); cleared {cleared} saved-state row(s)")
    return {
        "scenario": "amazon_passkey",
        "passkey_count": passkey_count,
        "cleared": cleared,
        "user_id": ctx.user_id,
        "auth_realm": ctx.auth_realm,
        "restore_snapshot": snapshot,
    }


def _apply_fresh_browser_state_scenario(ctx: LiveFixtureContext) -> dict:
    """Give a public browser probe a clean profile with no inherited identity."""
    snapshot = _snapshot_browser_state(ctx, include_passwords=False)
    cleared = _clear_browser_state(
        ctx,
        disable_passwords=False,
        disabled_reason="disabled by fresh-browser benchmark scenario",
    )
    print(f"    🧼 Prepared fresh browser state for {ctx.auth_realm}; cleared {cleared} saved-state row(s)")
    return {
        "scenario": "fresh_browser_state",
        "cleared": cleared,
        "user_id": ctx.user_id,
        "auth_realm": ctx.auth_realm,
        "restore_snapshot": snapshot,
    }


def _delete_kernel_profile(profile_id: str) -> None:
    """Delete a run-created external Kernel profile; missing profiles are already clean."""
    api_key = load_env_var("KERNEL_API_KEY", _BACKEND_ENV, _AGENTS_ENV)
    if not api_key:
        raise RuntimeError("KERNEL_API_KEY is required to delete an isolated benchmark profile")
    base_url = (load_env_var("KERNEL_API_BASE_URL", _BACKEND_ENV, _AGENTS_ENV) or "https://api.onkernel.com").rstrip(
        "/"
    )
    url = f"{base_url}/profiles/{quote(profile_id, safe='')}"
    last_error: Exception | None = None
    for attempt, delay in enumerate((0.0, 0.25, 0.5), start=1):
        if delay:
            time.sleep(delay)
        try:
            response = httpx.delete(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Accept": "*/*"},
                timeout=15,
            )
            if response.status_code == 404 or 200 <= response.status_code < 300:
                return
            last_error = RuntimeError(f"Kernel profile delete failed: HTTP {response.status_code}")
        except Exception as exc:
            last_error = exc
        if attempt == 3:
            break
    raise RuntimeError(f"Failed to delete isolated Kernel profile {profile_id}: {last_error}")


def _restore_isolated_browser_state_scenario(manifest: dict, *, label: str) -> None:
    """Restore shared browser auth after a destructive isolated browser run."""
    snapshot = manifest.get("restore_snapshot")
    if not isinstance(snapshot, dict):
        raise RuntimeError(f"{label} scenario did not capture a restore snapshot")
    user = _sql_literal(str(manifest["user_id"]))

    current_profile_ids_sql = (
        "SELECT COALESCE(json_agg(profile.\"profileId\"), '[]'::json)::text "
        'FROM "BrowserProviderProfile" profile JOIN "BrowserContext" context '
        'ON context.id = profile."contextId" '
        f"WHERE context.\"userId\" = {user} AND profile.provider = 'kernel';"
    )
    current_profile_ids = json.loads(_run_local_victoria_sql(current_profile_ids_sql))
    if not isinstance(current_profile_ids, list):
        raise RuntimeError(f"{label} restore could not read current Kernel profiles")
    snapshot_profiles = snapshot.get("profiles")
    if not isinstance(snapshot_profiles, list):
        raise RuntimeError(f"{label} restore snapshot has invalid profiles")
    snapshot_profile_ids = {
        str(profile.get("profileId"))
        for profile in snapshot_profiles
        if isinstance(profile, dict) and profile.get("profileId")
    }
    run_created_profile_ids = {
        str(profile_id) for profile_id in current_profile_ids if profile_id
    } - snapshot_profile_ids
    for profile_id in sorted(run_created_profile_ids):
        _delete_kernel_profile(profile_id)

    if not _sync_browser_credentials():
        raise RuntimeError(f"{label} scenario could not restore live browser credentials")

    def ids_sql(key: str) -> str:
        values = snapshot.get(key)
        if not isinstance(values, list):
            raise RuntimeError(f"{label} restore snapshot has invalid {key}")
        return ", ".join(_sql_literal(str(value)) for value in values)

    statements: list[str] = []
    for table, key in (
        ("SteelSessionAuth", "steel_ids"),
        ("CookieBundle", "bundle_ids"),
        ("BrowserPassword", "password_ids"),
    ):
        identifiers = ids_sql(key)
        if identifiers:
            statements.append(
                f'UPDATE "{table}" SET "disabledAt" = NULL, "disabledReason" = NULL WHERE id IN ({identifiers})'
            )

    statements.append(
        'DELETE FROM "BrowserProviderProfile" profile USING "BrowserContext" context '
        'WHERE profile."contextId" = context.id '
        f"AND context.\"userId\" = {user} AND profile.provider = 'kernel'"
    )
    if snapshot_profiles:
        profiles_json = _sql_literal(json.dumps(snapshot_profiles, separators=(",", ":")))
        statements.append(
            'INSERT INTO "BrowserProviderProfile" '
            'SELECT * FROM json_populate_recordset(NULL::"BrowserProviderProfile", '
            f"{profiles_json}::json)"
        )
    _run_local_victoria_sql("; ".join(statements) + ";")
    print(f"    🧹 Restored shared browser auth after {label} scenario")


def _restore_amazon_passkey_scenario(manifest: dict) -> None:
    """Restore shared browser auth after the destructive passkey-only run."""
    _restore_isolated_browser_state_scenario(manifest, label="Amazon passkey")


def _restore_live_fixture_scenarios(manifests: list[dict]) -> None:
    """Restore destructive task scenarios in reverse setup order."""
    for manifest in reversed(manifests):
        scenario = manifest.get("scenario")
        if scenario == "fresh_browser_state":
            _restore_isolated_browser_state_scenario(manifest, label="fresh browser state")
        elif scenario == "amazon_passkey" or manifest.get("fixture") == "amazon_passkey":
            _restore_amazon_passkey_scenario(manifest)


async def _restore_live_fixture_scenarios_async(manifests: list[dict]) -> None:
    """Restore blocking browser fixtures without freezing concurrent task polling."""
    await asyncio.to_thread(_restore_live_fixture_scenarios, manifests)


def _live_fixture_run_user_id(task: "BenchmarkTask") -> Optional[str]:
    """The production identity a task's declared live fixtures make it run as."""
    fixtures = resolve_live_fixtures(task.environment)
    if "live-tamy-identity" in fixtures or "live-tamy-account-snapshot" in fixtures:
        return TAMY_IDENTITY_USER_ID
    if "live-aman-food-plan-identity" in fixtures:
        return AMAN_FOOD_PLAN_USER_ID
    return None


def _apply_live_tamy_identity_fixture(ctx: LiveFixtureContext) -> dict:
    """Apply the complete live overlay for the Mexico production identity.

    The `live` overlay refreshes credentials for whichever identity the seed is
    pointed at, but the seed always resolved to the dev user, so a task launched
    with a different BENCHMARK_RUN_USER_ID ran against a DB that had no row for
    it at all. That is not a task failure: `POST /api/browser-session/init` 500s
    with `Foreign key constraint violated: AgentIdentity_userId_fkey` and the
    browser agent never starts.

    This is a complete live fixture, not a supplement to the default-user
    fixture: it refreshes compute tokens, retargets the browser-auth seed via
    SEED_LOCAL_USER_ID, and upserts the User record before any user-scoped row.
    Scoping the auth graph to her Amazon realms keeps the sync in seconds while
    retaining profiles, cookies/storage, passwords, passkeys, CookieBundles and
    Steel session markers. Fails closed if any part of that overlay cannot sync.
    """
    if _is_simulate_mode():
        print("    🌍 simulate mode — skipping the MX identity overlay")
        return {"fixture": "live-tamy-identity", "skipped": True, "reason": "simulate"}
    manifest = _apply_live_fixture(
        replace(
            ctx,
            user_id=TAMY_IDENTITY_USER_ID,
            cookie_domains=TAMY_IDENTITY_COOKIE_DOMAINS,
        )
    )
    print(f"    🇲🇽 Seeded Tamy's production identity {TAMY_IDENTITY_USER_ID} into the isolated DB")
    return {
        **manifest,
        "fixture": "live-tamy-identity",
        "user_id": TAMY_IDENTITY_USER_ID,
    }


def _seed_identity_account_snapshot(user_id: str, *, timeout: float = 900) -> bool:
    """Seed one production identity's ACCOUNT rows into the isolated benchmark DB.

    This is the full user-scoped prod->local sync (``seed-local.ts`` without a
    scoped flag): User, credits, subscription, integrations (+ pooled compute
    tokens), email credentials, contacts, message history, API keys, blueprints,
    SMS session and feedback. Browser auth is explicitly excluded: a snapshot is
    data the agent plans from, not a credential overlay, and simulate runs never
    open a real browser. Fails closed (returns False) so the fixture caller can
    refuse to start an agent against a DB that lacks the identity's rows.
    """
    database_url = _local_victoria_database_url()
    if not database_url:
        print("    ⚠ Account snapshot skipped: local Victoria DB not found")
        return False
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    env["SEED_LOCAL_USER_ID"] = user_id
    env["BENCHMARK_SKIP_BROWSER_AUTH_SYNC"] = "1"
    env.pop("SEED_COOKIE_DOMAINS", None)
    env.pop("SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL", None)
    try:
        result = _run_seed_subprocess(
            ["npx", "tsx", "scripts/seed-local.ts"],
            cwd=REPO_ROOT / "back-end",
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"    ⚠ Account snapshot timed out after {exc.timeout}s: {_seed_sync_error_detail(exc)}")
        return False
    except Exception as exc:
        print(f"    ⚠ Account snapshot error: {exc}")
        return False
    if result.returncode != 0:
        print(f"    ⚠ Account snapshot failed: {_seed_sync_error_detail(result)}")
        return False
    print(f"    📸 Seeded account snapshot for {user_id} (browser auth excluded)")
    return True


def _apply_live_tamy_account_snapshot_fixture(ctx: LiveFixtureContext) -> dict:
    """Seed Tamy's production account rows as the run's base environment.

    Unlike ``live-tamy-identity`` this is a DATA snapshot, not a credential
    overlay, so it applies under world-model simulate too: the WMH serves every
    provider boundary, but the agent still plans from her real contacts,
    history, subscription and integrations, and the run user must exist locally
    or ``POST /api/agents`` dies on the User FK before an agent exists. Browser
    auth is never synced. Compute tokens: simulate runs use the restored seed
    DB's pooled tokens (same as the run-level pre-flight); real runs refresh
    them like the other identity overlays so no LLM call falls to the paid
    waterfall.
    """
    simulate = _is_simulate_mode()
    if not simulate:
        if _anthropic_family_excluded():
            synced = _sync_compute_tokens(tolerate_gpt_code_unavailable=True, required_token_types=("gpt",))
        else:
            synced = _sync_compute_tokens(
                tolerate_gpt_code_unavailable=True,
                tolerate_claude_code_unavailable=ctx.tolerate_claude_code_unavailable,
            )
        if not synced:
            raise RuntimeError("Account snapshot fixture could not refresh compute tokens")
    else:
        print("    🌍 simulate mode — seeding the account snapshot without a credential overlay")
    if not _seed_identity_account_snapshot(TAMY_IDENTITY_USER_ID):
        raise RuntimeError("Account snapshot fixture could not seed Tamy's production account rows")
    print(f"    🇲🇽 Seeded Tamy's account snapshot {TAMY_IDENTITY_USER_ID} into the isolated DB")
    return {
        "fixture": "live-tamy-account-snapshot",
        "browser_auth": False,
        "source": "prod_sync",
        "user_id": TAMY_IDENTITY_USER_ID,
        "simulate": simulate,
    }


def _apply_live_aman_food_plan_identity_fixture(ctx: LiveFixtureContext) -> dict:
    """Apply the complete live overlay for Aman's DoorDash food-plan repro identity."""
    if _is_simulate_mode():
        print("    🌍 simulate mode — skipping the Aman food-plan identity overlay")
        return {"fixture": "live-aman-food-plan-identity", "skipped": True, "reason": "simulate"}
    manifest = _apply_live_fixture(
        replace(
            ctx,
            user_id=AMAN_FOOD_PLAN_USER_ID,
            cookie_domains=AMAN_FOOD_PLAN_COOKIE_DOMAINS,
        )
    )
    print(f"    🛒 Seeded Aman's production identity {AMAN_FOOD_PLAN_USER_ID} into the isolated DB")
    return {
        **manifest,
        "fixture": "live-aman-food-plan-identity",
        "user_id": AMAN_FOOD_PLAN_USER_ID,
    }


LIVE_FIXTURE_APPLIERS = {
    "live": _apply_live_fixture,
    "live-tamy-identity": _apply_live_tamy_identity_fixture,
    "live-tamy-account-snapshot": _apply_live_tamy_account_snapshot_fixture,
    "live-aman-food-plan-identity": _apply_live_aman_food_plan_identity_fixture,
}
assert set(LIVE_FIXTURE_APPLIERS) == set(LIVE_FIXTURE_NAMES), (
    f"live-fixture appliers {sorted(LIVE_FIXTURE_APPLIERS)} must match registry {sorted(LIVE_FIXTURE_NAMES)}"
)


async def _apply_memory_fixtures(task: "BenchmarkTask", base_url: str) -> list[dict]:
    """Load the task's planner-memory fixtures into the local stack's history table.

    A memory fixture (agents/benchmarks/fixtures/memory/<name>.json) is a set of
    pre-compressed PlannerMemory rows built from real passing bundles. Rows are
    upserted through the internal API so the memory-on arm retrieves exactly the
    declared history. Local stacks only: a prod base_url already holds the real
    history and must never receive fixture rows.
    """
    names = list((task.environment or {}).get("memory_fixtures") or [])
    if not names or task.memory != "on":
        return []
    if not _is_local_base_url(base_url):
        print(f"    🧠 memory fixtures {names} skipped (non-local base_url uses the real history table)")
        return []
    from scripts.build_memory_fixture import load_fixture

    headers = {**(await _api_headers())}
    applied: list[dict] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for name in names:
            fixture = load_fixture(name)
            for row in fixture.get("rows", []):
                body = {
                    k: v
                    for k, v in row.items()
                    if k
                    in {
                        "goal",
                        "benchmark_task_name",
                        "passed",
                        "root_status",
                        "world_model_mode",
                        "agent_created_at",
                        "critical_path",
                        "compressor_version",
                    }
                }
                resp = await client.put(f"{base_url}/api/planner-memory/{row['id']}", headers=headers, json=body)
                if resp.status_code != 200:
                    raise RuntimeError(
                        f"memory fixture {name}: upsert {row['id']} failed {resp.status_code} {resp.text[:200]}"
                    )
            applied.append({"fixture": name, "rows": len(fixture.get("rows", []))})
            print(f"    🧠 memory fixture {name}: {len(fixture.get('rows', []))} row(s) loaded")
    return applied


# The worker caches a user's context (their connected inboxes included) for
# helpers.get_user_context.CACHE_TTL_MINUTES. A lane that connected a fixture
# inbox therefore leaks it into the next lane's root agent as "the user's
# connected email", even though the inbox was deleted with its site: an agent
# then signed up with that address and waited on a code nobody could read.
USER_CONTEXT_CACHE_SECONDS = 5 * 60 + 15
_connected_inbox_released_at: Optional[float] = None


async def _wait_out_connected_inbox_context(now: Callable[[], float] = time.monotonic) -> float:
    """Sleep until the previous lane's fixture inbox has aged out of the worker's user context."""
    global _connected_inbox_released_at
    released_at = _connected_inbox_released_at
    _connected_inbox_released_at = None
    if released_at is None:
        return 0.0
    remaining = USER_CONTEXT_CACHE_SECONDS - (now() - released_at)
    if remaining <= 0:
        return 0.0
    print(f"    ⏳ Waiting {remaining:.0f}s for the previous lane's connected inbox to leave the cached user context")
    await asyncio.sleep(remaining)
    return remaining


async def _apply_auth_test_site(task: "BenchmarkTask", base_url: str) -> Optional[dict]:
    """Seed this run's Rose Shop site when the task declares one.

    The site is served by the local backend and reached through the public
    frontend proxy, so it only exists on a local benchmark stack. The returned
    manifest is also activated for this lane so the goal resolves
    {auth_test_site_url} and the evaluator can fetch the site's report.
    """
    scenario = auth_test_site.declared_scenario(task.environment)
    if scenario is None:
        return None
    if not _is_local_base_url(base_url):
        raise RuntimeError(f"{task.name}: the hosted auth test site only exists on a local benchmark stack")
    await _wait_out_connected_inbox_context()
    manifest = await auth_test_site.create_site(
        base_url,
        await _api_headers(),
        user_id=_current_benchmark_user_id(),
        scenario=scenario,
        public_base_url=_frontend_url_for_benchmark(base_url),
    )
    auth_test_site.set_active_manifest(manifest)
    print(
        f"    🔑 Rose Shop site {manifest['siteId']} ({scenario}): "
        f"{len(manifest.get('savedPasswordUsernames') or [])} saved password(s), "
        f"minted={manifest.get('mintedEmail') or 'none'}"
    )
    first_run_prompt = (auth_test_site.declared_block(task.environment) or {}).get("first_run_prompt")
    if first_run_prompt:
        try:
            await _run_auth_test_site_first_run(task, base_url, manifest, first_run_prompt)
        except BaseException:
            await _release_auth_test_site(base_url, manifest)
            raise
    return manifest


async def _run_auth_test_site_first_run(
    task: "BenchmarkTask", base_url: str, manifest: dict, first_run_prompt: str
) -> None:
    """Run one agent to completion on the site before the graded run.

    Behavior that spans two runs (a login that failed is not offered again, an
    account made earlier can be signed into) needs a real first run whose only
    job is to leave that state behind. It must complete; the graded run and the
    evaluators then see the site's event log split by a run marker.
    """
    first_task = replace(
        task,
        prompt=first_run_prompt,
        approval_handling=None,
        expected_approval_count=None,
        expected_attention_kind=None,
        enforce_declared_evaluators=False,
        evaluators=[],
    )
    first_agent_id = await create_agent(base_url, first_task)
    owned = _register_task_root(task.name, first_agent_id, "fixture_first_run")
    manifest["firstRunAgentId"] = first_agent_id
    print(f"    ① First run agent created: {first_agent_id[:12]}...")
    try:
        data, _triggered, _resolved, early_fail = await poll_agent(base_url, first_agent_id, first_task)
    except BaseException as error:
        if owned is not None:
            owned["stage_outcome"] = "cancelled" if isinstance(error, asyncio.CancelledError) else "error"
            owned["logs"]["fixture_error_type"] = type(error).__name__
        raise
    observed_id = (data.get("agent") or {}).get("id")
    if observed_id is not None and observed_id != first_agent_id:
        if owned is not None:
            owned["stage_outcome"] = "error"
            owned["logs"]["fixture_error_type"] = "foreign_snapshot"
        raise auth_test_site.AuthTestSiteFixtureError("first run snapshot has a foreign root identity")
    status = (data.get("agent") or {}).get("status")
    if owned is not None:
        owned["stage_outcome"] = "completed" if status == "COMPLETED" and not early_fail else "failed"
        owned["logs"]["fixture_snapshot"] = data
        owned["logs"]["fixture_early_failure"] = early_fail
    if early_fail or status != "COMPLETED":
        raise auth_test_site.AuthTestSiteFirstRunFailed(
            f"first run did not complete (status={status}, reason={early_fail}); agent {first_agent_id}"
        )
    await auth_test_site.mark_run(base_url, await _api_headers(), str(manifest["siteId"]), "graded-run")
    print(f"    ① First run completed; graded run starts on site {manifest['siteId']}")


async def _release_auth_test_site(base_url: str, manifest: Optional[dict]) -> None:
    global _connected_inbox_released_at
    auth_test_site.set_active_manifest(None)
    if not manifest:
        return
    if (manifest.get("authOptionsPreview") or {}).get("emailOtpInboxes"):
        _connected_inbox_released_at = time.monotonic()
    try:
        await auth_test_site.delete_site(
            base_url,
            await _api_headers(),
            str(manifest["siteId"]),
            user_id=_current_benchmark_user_id(),
        )
    except Exception as exc:
        print(f"    ⚠ Failed to delete Rose Shop site {manifest.get('siteId')}: {exc}")


async def _hydrate_auth_test_site_evidence(
    data: dict, base_url: Optional[str], *, task: Optional[BenchmarkTask] = None
) -> None:
    manifest = auth_test_site.active_manifest()
    evidence: dict = {"manifest": manifest, "report": None, "report_error": None}
    if not manifest:
        evidence["report_error"] = "no auth test site was created for this run"
    elif not base_url:
        evidence["report_error"] = "no backend base_url to fetch the site report from"
    else:
        try:
            evidence["report"] = await auth_test_site.fetch_report(
                base_url, await _api_headers(), str(manifest["siteId"])
            )
        except Exception as exc:
            evidence["report_error"] = str(exc)
    from benchmarks.parked_browser_page import measurement_required, parked_page_observation
    if task is not None and measurement_required(task):
        evidence["browser_page_observation"] = parked_page_observation(
            data, manifest, _current_benchmark_user_id()
        )
    data.setdefault("_benchmark", {})["auth_test_site"] = evidence


async def _apply_live_fixtures(task: "BenchmarkTask", base_url: str) -> list[dict]:
    """Apply every live fixture the task's environment resolves to, in order.

    Live fixtures only apply against the local benchmark stack. Scenario-specific
    mutations remain explicit task setup and are not added to the fixture registry.
    """
    fixtures = resolve_live_fixtures(task.environment)
    if not fixtures:
        return []
    if not _is_local_base_url(base_url):
        # Live fixtures mutate the local isolated DB; never touch a prod base_url.
        return []
    auth_realm = os.environ.get("BENCHMARK_BROWSER_AUTH_REALM") or "amazon.com"
    raw_domains = (task.environment or {}).get("live_cookie_domains") or []
    cookie_domains = tuple(str(d).strip() for d in raw_domains if str(d).strip())
    raw_required_domains = (task.environment or {}).get("required_injectable_cookie_domains") or []
    required_cookie_domains = tuple(str(d).strip() for d in raw_required_domains if str(d).strip())
    # Same reasoning as the blanket pre-flight above: a missing Claude compute
    # token degrades cost, it does not remove a capability the task needs. Live
    # fixtures never require claudeAuth, so this path only ever takes the
    # tolerant branch — it derives tolerance the same way the pre-flight does so
    # the two cannot disagree about whether a run may proceed.
    #
    # Epoch 4 of the ecommerce descent died here on the fail-closed form (the dev
    # claude_code row was EXPIRED and the rest rate-limited, so three tasks died
    # on "No usable claude_code integrations after sync" at $0.00, before an
    # agent existed). That is now narrower — an Anthropic key satisfies it — but
    # "no token AND no key" still aborts. See the residual-exposure note in
    # `test_live_fixture_tolerates_missing_claude_compute_token`.
    tolerate_missing_claude = await _has_usable_anthropic_api_key_fallback(base_url)
    ctx = LiveFixtureContext(
        base_url=base_url,
        user_id=USER_ID,
        auth_realm=auth_realm,
        cookie_domains=cookie_domains,
        required_injectable_cookie_domains=required_cookie_domains,
        tolerate_claude_code_unavailable=tolerate_missing_claude,
    )
    if _task_needs_auth(task):
        domains = _needs_auth_domains(task)
        domain_hint = f" ({', '.join(domains)})" if domains else ""
        print(
            f"    🔐 needs_auth: this bench requires a valid live auth token/session"
            f"{domain_hint} — injectable CookieBundles alone are not sufficient"
        )
    manifests: list[dict] = []
    for name in fixtures:
        applier = LIVE_FIXTURE_APPLIERS.get(name)
        if applier is None:
            raise RuntimeError(f"{task.name}: unknown live_fixture '{name}'")
        # Credential overlays shell out to seed processes and can take minutes.
        # Keep that blocking work off the event loop so an unrelated benchmark
        # lane can still poll its agent and observe completion before its cap.
        manifests.append(await asyncio.to_thread(applier, ctx))
    if task.name == AMAZON_PASSKEY_TASK_NAME and not _is_simulate_mode():
        manifests.append(await asyncio.to_thread(_apply_amazon_passkey_scenario, ctx))
    return manifests


def _run_grep_fixture(action: str, *args: str) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/grep-benchmark-fixture.ts", action, *args],
        cwd=REPO_ROOT / "back-end",
        env=_grep_fixture_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"grep benchmark fixture {action} failed: {result.stderr.strip()}")
    stdout = result.stdout.strip()
    return json.loads(stdout) if stdout else {}


def _message_text(message: dict) -> str:
    from benchmarks.completion_evidence import completion_message_text

    return completion_message_text(message)


def _tool_messages(messages: List[dict], tool_name: str) -> List[dict]:
    rows = []
    for message in messages:
        meta = message.get("metadata") or {}
        if meta.get("toolName") == tool_name and meta.get("toolStatus") == "FINISHED":
            rows.append(message)
    return rows


async def _grep_explore_stress_tree_messages(base_url: str, root_agent_id: str) -> List[dict]:
    agents = await get_agent_tree(base_url, root_agent_id)
    agent_ids = [a.get("agent_id") for a in agents if a.get("agent_id")] or [root_agent_id]
    messages: List[dict] = []
    for agent_id in agent_ids:
        try:
            data = await get_agent(base_url, str(agent_id))
        except Exception:
            continue
        messages.extend(data.get("messages", []))
    return messages


def _near(text: str, left: str, right: str, window: int = 600) -> bool:
    for match in re.finditer(re.escape(left), text):
        start = max(0, match.start() - window)
        end = min(len(text), match.end() + window)
        if right in text[start:end]:
            return True
    return False


async def evaluate_grep_explore_stress(
    base_url: str,
    root_agent_id: str,
    manifest: dict,
) -> Tuple[bool, Optional[str]]:
    messages = await _grep_explore_stress_tree_messages(base_url, root_agent_id)
    grep_messages = _tool_messages(messages, "grep")
    grep_text = "\n".join(_message_text(message) for message in grep_messages)
    grep_text_lower = grep_text.lower()

    if len(grep_messages) < 12:
        return False, f"Expected at least 12 completed Grep calls, found {len(grep_messages)}"

    forbidden_key_patterns = [
        ("person_id", r'(^|\n)- \*\*person_id\*\*:|"person_id"\s*:'),
        ("since", r'(^|\n)- \*\*since\*\*:|"since"\s*:'),
        ("limit", r'(^|\n)- \*\*limit\*\*:|"limit"\s*:'),
        ("output_mode", r'(^|\n)- \*\*output_mode\*\*:|"output_mode"\s*:'),
        ("search_in", r'(^|\n)- \*\*search_in\*\*:|"search_in"\s*:'),
        ("tool_name", r'(^|\n)- \*\*tool_name\*\*:|"tool_name"\s*:'),
        ("tool_status", r'(^|\n)- \*\*tool_status\*\*:|"tool_status"\s*:'),
    ]
    for label, pattern in forbidden_key_patterns:
        if re.search(pattern, grep_text_lower):
            return False, f"Unsupported Grep parameter appeared in transcript: {label}"

    forbidden_sources = ["agent_network_user_messages", "agent_network_tool_results"]
    for source in forbidden_sources:
        if source in grep_text_lower:
            return False, f"Unsupported Grep source appeared in transcript: {source}"

    required_tokens = [
        "source: messages",
        "source: network",
        "source: agent_network",
        "-i",
        "multiline",
        "-a",
        "-b",
        "context",
        "-n",
        "head_limit",
        "offset",
    ]
    missing = [token for token in required_tokens if token not in grep_text_lower]
    if missing:
        return False, "Missing required Grep flag/source coverage: " + ", ".join(missing)

    expected_evidence = [
        manifest["messages"]["regex"],
        manifest["messages"]["multiline_start"],
        manifest["messages"]["multiline_end"],
        manifest["messages"]["after_context"],
        manifest["messages"]["before_context"],
        manifest["messages"]["pagination"],
        manifest["messages"]["mixed_case"],
        manifest["network"]["company"],
        manifest["network"]["title"],
        manifest["network"]["relation"],
        manifest["agent_network"]["user"],
        manifest["agent_network"]["assistant"],
    ]
    missing_evidence = [value for value in expected_evidence if value not in grep_text]
    if missing_evidence:
        return False, "Missing exact overlay evidence in Grep results: " + "; ".join(missing_evidence)

    for role in ["USER", "ASSISTANT", "TOOL"]:
        if not _near(grep_text, "role", role):
            return False, f"agent_network match metadata did not include role {role}"

    if "1:" in grep_text and "-n: false" in grep_text_lower:
        no_number_blocks = [
            _message_text(message) for message in grep_messages if "-n: false" in _message_text(message).lower()
        ]
        if any(re.search(r"^\d+:", block, re.MULTILINE) for block in no_number_blocks):
            return False, "-n:false Grep result still included line numbers"

    return True, None


async def evaluate_plaid_transaction_task(
    task: BenchmarkTask,
    base_url: str,
    root_agent_id: str,
    manifest: dict,
) -> Tuple[bool, Optional[str]]:
    messages = await _grep_explore_stress_tree_messages(base_url, root_agent_id)
    grep_messages = _tool_messages(messages, "grep")
    all_text = "\n".join(_message_text(message) for message in messages)
    grep_text = "\n".join(_message_text(message) for message in grep_messages)
    all_lower = all_text.lower()
    grep_lower = grep_text.lower()

    has_transaction_source = (
        "source: transactions" in grep_lower
        or '"source": "transactions"' in grep_lower
        or "source: transactions" in all_lower
        or '"source": "transactions"' in all_lower
        or "grep:transactions" in all_lower
    )
    if not has_transaction_source:
        return False, "Expected grep(source='transactions') evidence in transcript"

    if task.name == "plaid-transactions-monthly-spend":
        expected = str(manifest.get("monthly_spend_sep_2025_usd") or manifest.get("monthly_spend_sep_2023_usd", ""))
        if expected and expected not in all_text:
            return False, f"Expected September 2025 spend {expected} in final/evidence text"
        if "2025-09" not in grep_text and "2025-09-01" not in grep_text:
            return False, "Expected September 2025 transaction evidence"
        return True, None

    if task.name == "plaid-transactions-doordash-count":
        expected_count = manifest.get("doordash_orders_2025")
        if expected_count is not None and str(expected_count) not in all_text:
            return False, f"Expected DoorDash count {expected_count} in final/evidence text"
        if "doordash" not in grep_lower and "doordash" not in all_lower:
            return False, "Expected DoorDash transaction evidence"
        return True, None

    if task.name == "plaid-transactions-dead-subscriptions":
        candidate_text = all_text
        candidate_matches = list(
            re.finditer(
                r"(?:refund_prep_candidates|refund prep candidates|refund targets)(.*?)(?:excluded_subscription_candidates|excluded subscription candidates|excluded candidates|$)",
                all_text,
                flags=re.IGNORECASE | re.DOTALL,
            )
        )
        if candidate_matches:
            candidate_match = candidate_matches[-1]
            candidate_text = candidate_match.group(1)
        candidate_lower = candidate_text.lower()

        expected_candidates = [
            str(name)
            for name in (
                manifest.get("dead_subscription_expected_include") or manifest.get("dead_subscription_candidates", [])
            )
            if str(name).strip()
        ]
        excluded_candidates = [
            str(name) for name in manifest.get("dead_subscription_expected_exclude", ["GitHub"]) if str(name).strip()
        ]
        missing = [name for name in expected_candidates if name.lower() not in candidate_lower]
        if missing:
            return False, "Missing expected dead subscription candidates: " + ", ".join(missing)
        bad_exclusions = []
        for name in excluded_candidates:
            needle = name.lower()
            start = 0
            while True:
                index = candidate_lower.find(needle, start)
                if index < 0:
                    break
                window = candidate_lower[max(0, index - 140) : index + len(needle) + 140]
                if needle == "amazon prime" and "amazon prime video" in window:
                    start = index + len(needle)
                    continue
                has_exclusion_context = any(
                    marker in window
                    for marker in [
                        "exclude",
                        "excluded",
                        "not a dead",
                        "not dead",
                        "active",
                        "recent",
                        "developer",
                        "do not list",
                        "should not",
                    ]
                )
                has_candidate_context = any(
                    marker in window
                    for marker in ["refund", "cancel", "dead subscription", "unused", "candidate", "target"]
                )
                if has_candidate_context and not has_exclusion_context:
                    bad_exclusions.append(name)
                    break
                start = index + len(needle)
        if bad_exclusions and len(expected_candidates) > 0:
            return False, "Excluded active/recent/developer subscriptions should not be listed as dead: " + ", ".join(
                bad_exclusions
            )
        return True, None

    return True, None


def _force_show_passwords_mode() -> bool:
    return os.environ.get(BENCHMARK_FORCE_SHOW_PASSWORDS_ENV, "").lower() in {"1", "true", "yes"}


def _apply_anon_benchmark_mode(*, force_show_passwords: bool = False) -> None:
    """Force auth benchmarks to exercise freshly minted credentials."""
    os.environ["BENCHMARK_MINTED_CLEAR_EXISTING_AUTH"] = "true"
    os.environ["BENCHMARK_ANON_STEEL_PROFILE"] = "true"
    if force_show_passwords:
        os.environ[BENCHMARK_FORCE_SHOW_PASSWORDS_ENV] = "true"
        os.environ.pop("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", None)
    else:
        os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = "true"


def _delete_local_minted_accounts_for_user(user_id: str, *, reset_agent_identity: bool = False) -> int:
    """Delete per-site minted account rows for the benchmark user.

    AgentIdentity is deliberately preserved by default. It owns the one
    primitive inbox and one AgentPhone number for the user, and deleting it
    forces AgentPhone to provision a fresh paid number on every benchmark run.
    Set BENCHMARK_MINTED_RESET_AGENT_IDENTITY=true only when intentionally
    re-proving first-time identity provisioning.
    """
    if reset_agent_identity:
        sql = (
            'WITH deleted_minted AS (DELETE FROM "MintedAccount" '
            f'WHERE "userId" = {_sql_literal(user_id)} RETURNING id), '
            'deleted_identity AS (DELETE FROM "AgentIdentity" '
            f'WHERE "userId" = {_sql_literal(user_id)} RETURNING id) '
            "SELECT COUNT(*) FROM deleted_minted;"
        )
    else:
        sql = (
            'WITH deleted_minted AS (DELETE FROM "MintedAccount" '
            f'WHERE "userId" = {_sql_literal(user_id)} RETURNING id) '
            "SELECT COUNT(*) FROM deleted_minted;"
        )
    out = _run_local_victoria_sql(sql)
    try:
        return int(out.splitlines()[-1].strip() or "0")
    except Exception:
        return 0


def _disable_local_auth_material_for_realm(user_id: str, auth_realm: str) -> int:
    """Disable local saved auth for one realm so minted credentials are exposed.

    This is intentionally opt-in for live minted probes. It only touches the
    benchmark user's local DB rows for the target realm.
    """
    now = "NOW()"
    reason = _sql_literal("disabled by minted benchmark auth probe")
    realm = _sql_literal(auth_realm)
    user = _sql_literal(user_id)
    like_realm = _sql_literal(f"%{auth_realm}%")
    sql = (
        'WITH steel AS (UPDATE "SteelSessionAuth" '
        f'SET "disabledAt" = {now}, "disabledReason" = {reason} '
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id), '
        'bundles AS (UPDATE "CookieBundle" '
        f'SET "disabledAt" = {now}, "disabledReason" = {reason} '
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id), '
        'passwords AS (UPDATE "BrowserPassword" '
        f'SET "disabledAt" = {now}, "disabledReason" = {reason} '
        f'WHERE "userId" = {user} AND "origin" LIKE {like_realm} AND "disabledAt" IS NULL RETURNING id) '
        "SELECT (SELECT COUNT(*) FROM steel) + "
        "(SELECT COUNT(*) FROM bundles) + "
        "(SELECT COUNT(*) FROM passwords);"
    )
    out = _run_local_victoria_sql(sql)
    try:
        return int(out.splitlines()[-1].strip() or "0")
    except Exception:
        return 0


def _disable_local_steel_and_cookie_auth_for_realm(user_id: str, auth_realm: str) -> int:
    """Disable existing local Steel/CookieBundle auth for one realm without hiding passwords."""
    now = "NOW()"
    reason = _sql_literal("disabled by force-show-passwords auth benchmark")
    realm = _sql_literal(auth_realm)
    user = _sql_literal(user_id)
    sql = (
        'WITH steel AS (UPDATE "SteelSessionAuth" '
        f'SET "disabledAt" = {now}, "disabledReason" = {reason} '
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id), '
        'bundles AS (UPDATE "CookieBundle" '
        f'SET "disabledAt" = {now}, "disabledReason" = {reason} '
        f'WHERE "userId" = {user} AND "authRealm" = {realm} AND "disabledAt" IS NULL RETURNING id) '
        "SELECT (SELECT COUNT(*) FROM steel) + (SELECT COUNT(*) FROM bundles);"
    )
    out = _run_local_victoria_sql(sql)
    try:
        return int(out.splitlines()[-1].strip() or "0")
    except Exception:
        return 0


def _encrypt_benchmark_secret(plaintext: str) -> str:
    """Encrypt a seeded benchmark password with the app's shared RSA public key."""
    import base64

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    public_key_pem = b"""-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjSyJhixvre5abdAOA8QK
MZN9ftryV1ST5bQ/Ne2SsA0LUlsy/t0gVickAHf/iMAI473qBGrJIgYgEBrnQ9Vy
ak1DpYWG9rC8KNZs/AQnWHiDWKGNUwWTAbT0fZeDHbckgJXiAok2U23F7tHtA1v6
V65dHj1C+wlb8bBkJtDgSxKIcG6GMZFfR5Arzq8ILQ20mtAP2HW80SeWGiw6Ecnd
a0RL0kn3Mqzjuw8NB4Iqx7UThKuIZdEnUhdnlVcXhfpEJUngcOm6pqQGNQok+VtL
MHxsrQsQo0UMgE8zQamTXpTGJEB1G22gPaEY5FB2V8dgWs6PxBTaYZMOH9TRy2G4
EwIDAQAB
-----END PUBLIC KEY-----"""
    public_key = serialization.load_pem_public_key(public_key_pem)
    aes_key = os.urandom(32)
    iv = os.urandom(12)
    cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(plaintext.encode("utf-8")) + encryptor.finalize()
    encrypted_aes_key = public_key.encrypt(
        aes_key,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    envelope = {
        "version": 1,
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext + encryptor.tag).decode("utf-8"),
        "encrypted_aes_key": base64.b64encode(encrypted_aes_key).decode("utf-8"),
    }
    return base64.b64encode(json.dumps(envelope).encode("utf-8")).decode("utf-8")


def _seed_local_bad_amazon_auth_scenario(user_id: str, auth_realm: str) -> dict:
    """Seed one bad CookieBundle and two bad Amazon password rows for auth e2e coverage."""
    if auth_realm != "amazon.com":
        raise RuntimeError("--force-show-passwords currently only supports the amazon.com auth benchmark.")
    password_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    bundle_id = str(uuid.uuid4())
    cookie_id = str(uuid.uuid4())
    bad_passwords = [
        _encrypt_benchmark_secret(f"benchmark-wrong-password-{password_ids[0]}"),
        _encrypt_benchmark_secret(f"benchmark-wrong-password-{password_ids[1]}"),
    ]
    user = _sql_literal(user_id)
    username = _sql_literal(BAD_AMAZON_PASSWORD_USERNAME)
    reason = _sql_literal("superseded by force-show-passwords benchmark fixture")
    source = _sql_literal(BAD_AMAZON_COOKIE_SOURCE)
    profile = _sql_literal(BAD_AMAZON_COOKIE_PROFILE)
    realm = _sql_literal(auth_realm)
    password_values = [
        (
            _sql_literal(password_ids[0]),
            _sql_literal("https://amazon.com"),
            _sql_literal(bad_passwords[0]),
            _sql_literal("benchmark bad password 1"),
        ),
        (
            _sql_literal(password_ids[1]),
            _sql_literal("https://www.amazon.com/ap/signin"),
            _sql_literal(bad_passwords[1]),
            _sql_literal("benchmark bad password 2"),
        ),
    ]
    sql = (
        'WITH disabled_old_passwords AS (UPDATE "BrowserPassword" '
        f'SET "disabledAt" = NOW(), "disabledReason" = {reason} '
        f'WHERE "userId" = {user} '
        "AND (LOWER(origin) LIKE '%amazon.com%' OR LOWER(origin) LIKE '%www.amazon.com%') "
        f'AND "disabledAt" IS NULL RETURNING id), '
        'upsert_bundle AS (INSERT INTO "CookieBundle" '
        '(id, "userId", "authRealm", "browserSource", "browserProfile", "accountLabel", '
        '"disabledAt", "disabledReason", "createdAt", "updatedAt") VALUES '
        f"({_sql_literal(bundle_id)}, {user}, {realm}, {source}, {profile}, "
        f"{_sql_literal(BAD_AMAZON_PASSWORD_USERNAME)}, NULL, NULL, NOW(), NOW()) "
        'ON CONFLICT ("userId", "authRealm", "browserSource", "browserProfile") DO UPDATE SET '
        '"accountLabel" = EXCLUDED."accountLabel", "disabledAt" = NULL, "disabledReason" = NULL, '
        '"updatedAt" = NOW() RETURNING id), '
        'upsert_cookie AS (INSERT INTO "Cookie" '
        '(id, "userId", domain, name, path, value, "expiresUtc", "isSecure", "isHttpOnly", '
        '"browserSource", "browserProfile", "creationUtc", "hasExpires", "isPersistent", '
        '"lastAccessUtc", "lastUpdateUtc", priority, "sameSite", "sourcePort", "sourceScheme", "topFrameSiteKey") '
        "VALUES "
        f"({_sql_literal(cookie_id)}, {user}, {_sql_literal('.amazon.com')}, "
        f"{_sql_literal('benchmark_bad_auth')}, {_sql_literal('/')}, {_sql_literal('bad-cookie-' + cookie_id)}, "
        "((EXTRACT(EPOCH FROM NOW() + INTERVAL '7 days') + 11644473600) * 1000000)::bigint, "
        f"true, true, {source}, {profile}, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        "true, true, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        f"1, -1, -1, 2, {_sql_literal('')}) "
        'ON CONFLICT ("userId", domain, name, path, "topFrameSiteKey", "browserSource", "browserProfile") '
        'DO UPDATE SET value = EXCLUDED.value, "expiresUtc" = EXCLUDED."expiresUtc", '
        '"creationUtc" = EXCLUDED."creationUtc", "lastAccessUtc" = EXCLUDED."lastAccessUtc", '
        '"lastUpdateUtc" = EXCLUDED."lastUpdateUtc" RETURNING id), '
        'upsert_pwd1 AS (INSERT INTO "BrowserPassword" '
        '(id, "userId", origin, username, "encryptedPassword", "dateLastUsed", "dateCreated", '
        '"browserSource", "browserProfile", "disabledAt", "disabledReason") VALUES '
        f"({password_values[0][0]}, {user}, {password_values[0][1]}, {username}, {password_values[0][2]}, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        f"{source}, {profile}, NULL, NULL) "
        'ON CONFLICT ("userId", origin, username) DO UPDATE SET '
        '"encryptedPassword" = EXCLUDED."encryptedPassword", "dateLastUsed" = EXCLUDED."dateLastUsed", '
        '"browserSource" = EXCLUDED."browserSource", "browserProfile" = EXCLUDED."browserProfile", '
        '"disabledAt" = NULL, "disabledReason" = NULL RETURNING id), '
        'upsert_pwd2 AS (INSERT INTO "BrowserPassword" '
        '(id, "userId", origin, username, "encryptedPassword", "dateLastUsed", "dateCreated", '
        '"browserSource", "browserProfile", "disabledAt", "disabledReason") VALUES '
        f"({password_values[1][0]}, {user}, {password_values[1][1]}, {username}, {password_values[1][2]}, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        "((EXTRACT(EPOCH FROM NOW()) + 11644473600) * 1000000)::bigint, "
        f"{source}, {profile}, NULL, NULL) "
        'ON CONFLICT ("userId", origin, username) DO UPDATE SET '
        '"encryptedPassword" = EXCLUDED."encryptedPassword", "dateLastUsed" = EXCLUDED."dateLastUsed", '
        '"browserSource" = EXCLUDED."browserSource", "browserProfile" = EXCLUDED."browserProfile", '
        '"disabledAt" = NULL, "disabledReason" = NULL RETURNING id) '
        "SELECT "
        "(SELECT id FROM upsert_bundle), "
        "(SELECT id FROM upsert_pwd1), "
        "(SELECT id FROM upsert_pwd2);"
    )
    out = _run_local_victoria_sql(sql)
    fields = (out.splitlines()[-1] if out else "").split("\t")
    if len(fields) != 3:
        raise RuntimeError(f"Failed to seed bad Amazon auth fixture: {out}")
    fixture = {"cookie_bundle_id": fields[0], "password_ids": [fields[1], fields[2]]}
    os.environ["BENCHMARK_BAD_AUTH_COOKIE_BUNDLE_ID"] = fixture["cookie_bundle_id"]
    os.environ["BENCHMARK_BAD_AUTH_PASSWORD_IDS"] = ",".join(fixture["password_ids"])
    return fixture


def _validate_bad_amazon_auth_scenario(user_id: str) -> Tuple[bool, Optional[str]]:
    cookie_bundle_id = os.environ.get("BENCHMARK_BAD_AUTH_COOKIE_BUNDLE_ID", "")
    password_ids = [value for value in os.environ.get("BENCHMARK_BAD_AUTH_PASSWORD_IDS", "").split(",") if value]
    if not cookie_bundle_id or not password_ids:
        return False, "bad Amazon auth fixture ids were not recorded"
    ids = ", ".join(_sql_literal(value) for value in [cookie_bundle_id, *password_ids])
    password_id_list = ", ".join(_sql_literal(value) for value in password_ids)
    sql = (
        "SELECT kind, id, disabled FROM ("
        f"SELECT 'cookie_bundle' AS kind, id, (\"disabledAt\" IS NOT NULL) AS disabled "
        f'FROM "CookieBundle" WHERE "userId" = {_sql_literal(user_id)} AND id IN ({ids}) '
        "UNION ALL "
        f"SELECT 'password' AS kind, id, (\"disabledAt\" IS NOT NULL) AS disabled "
        f'FROM "BrowserPassword" WHERE "userId" = {_sql_literal(user_id)} AND id IN ({password_id_list})'
        ") rows ORDER BY kind, id;"
    )
    rows = [line.split("\t") for line in _run_local_victoria_sql(sql).splitlines() if line.strip()]
    disabled_by_key = {(row[0], row[1]): row[2] == "t" for row in rows if len(row) == 3}
    missing = []
    if ("cookie_bundle", cookie_bundle_id) not in disabled_by_key:
        missing.append(f"cookie_bundle:{cookie_bundle_id}")
    for password_id in password_ids:
        if ("password", password_id) not in disabled_by_key:
            missing.append(f"password:{password_id}")
    if missing:
        return False, "seeded credential rows missing after run: " + ", ".join(missing)
    not_disabled = [
        f"{kind}:{credential_id}" for (kind, credential_id), disabled in disabled_by_key.items() if not disabled
    ]
    if not_disabled:
        return False, "seeded credentials were not disabled: " + ", ".join(not_disabled)
    return True, None


def _local_agent_identity_present_for_user(user_id: str) -> bool:
    sql = f'SELECT 1 FROM "AgentIdentity" WHERE "userId" = {_sql_literal(user_id)} LIMIT 1;'
    return bool(_run_local_victoria_sql(sql).strip())


def _local_agent_identity_email_for_user(user_id: str) -> Optional[str]:
    sql = f'SELECT email FROM "AgentIdentity" WHERE "userId" = {_sql_literal(user_id)} LIMIT 1;'
    out = _run_local_victoria_sql(sql).strip()
    return out.splitlines()[0].strip() if out else None


def _seed_local_benchmark_agent_identity_if_missing(user_id: str) -> Optional[str]:
    """Seed the cached local benchmark identity so live runs do not mint new inboxes.

    This is intentionally local-benchmark scoped. First-provisioning tests can opt out
    by setting BENCHMARK_MINTED_RESET_AGENT_IDENTITY=true.
    """
    if _local_agent_identity_present_for_user(user_id):
        return None

    email = (os.environ.get("BENCHMARK_MINTED_AGENT_EMAIL") or DEFAULT_MINTED_BENCHMARK_AGENT_EMAIL).strip()
    phone = (os.environ.get("BENCHMARK_MINTED_AGENT_PHONE") or DEFAULT_MINTED_BENCHMARK_AGENT_PHONE).strip()
    if not email:
        return None

    fields = ["id", '"userId"', "email", '"createdAt"']
    values = ["gen_random_uuid()", _sql_literal(user_id), _sql_literal(email), "NOW()"]
    updates = ["email = EXCLUDED.email"]

    if phone:
        fields.extend(["phone", '"phoneProvider"'])
        values.extend([_sql_literal(phone), _sql_literal("agentphone")])
        updates.extend(
            [
                "phone = EXCLUDED.phone",
                '"phoneProvider" = EXCLUDED."phoneProvider"',
            ]
        )

    provider_agent_id = os.environ.get("BENCHMARK_MINTED_AGENTPHONE_AGENT_ID", "").strip()
    provider_number_id = os.environ.get("BENCHMARK_MINTED_AGENTPHONE_NUMBER_ID", "").strip()
    if provider_agent_id:
        fields.append('"phoneProviderAgentId"')
        values.append(_sql_literal(provider_agent_id))
        updates.append('"phoneProviderAgentId" = EXCLUDED."phoneProviderAgentId"')
    if provider_number_id:
        fields.append('"phoneProviderNumberId"')
        values.append(_sql_literal(provider_number_id))
        updates.append('"phoneProviderNumberId" = EXCLUDED."phoneProviderNumberId"')

    sql = (
        'INSERT INTO "AgentIdentity" '
        f"({', '.join(fields)}) VALUES ({', '.join(values)}) "
        'ON CONFLICT ("userId") DO UPDATE SET '
        f"{', '.join(updates)} "
        "RETURNING email;"
    )
    out = _run_local_victoria_sql(sql).strip()
    return out.splitlines()[0].strip() if out else email


def _prepare_local_agent_sms_sender(user_id: str) -> Optional[str]:
    """Ensure the isolated live bench has an AgentPhone sender selector."""
    seeded_email = _seed_local_benchmark_agent_identity_if_missing(user_id)
    phone = (os.environ.get("BENCHMARK_MINTED_AGENT_PHONE") or DEFAULT_MINTED_BENCHMARK_AGENT_PHONE).strip()
    if not phone:
        raise RuntimeError("Agent SMS benchmark requires a configured AgentPhone sender")

    # The live SMS benchmark owns its isolated database fixture. Pin it to the
    # campaign-backed sender and clear cached provider IDs so a released number
    # from an older base image cannot take precedence over `from_number`.
    _run_local_victoria_sql(
        'UPDATE "AgentIdentity" SET '
        f"phone = {_sql_literal(phone)}, "
        "\"phoneProvider\" = 'agentphone', "
        '"phoneProviderAgentId" = NULL, '
        '"phoneProviderNumberId" = NULL '
        f'WHERE "userId" = {_sql_literal(user_id)};'
    )
    sql = (
        "SELECT CASE WHEN \"phoneProvider\" = 'agentphone' AND ("
        "phone ~ '^\\+[1-9][0-9]{1,14}$' OR "
        "COALESCE(\"phoneProviderAgentId\", '') <> '' OR "
        "COALESCE(\"phoneProviderNumberId\", '') <> ''"
        ") THEN 'ready' ELSE 'invalid' END "
        f'FROM "AgentIdentity" WHERE "userId" = {_sql_literal(user_id)} LIMIT 1;'
    )
    if _run_local_victoria_sql(sql).strip() != "ready":
        raise RuntimeError("Agent SMS benchmark requires an AgentPhone identity with a sender selector")
    return seeded_email


def _local_minted_account_labels_for_user(user_id: str) -> List[str]:
    sql = (
        'SELECT "accountLabel" FROM "MintedAccount" '
        f'WHERE "userId" = {_sql_literal(user_id)} AND "accountLabel" IS NOT NULL;'
    )
    out = _run_local_victoria_sql(sql)
    if not out:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


async def _delete_primitive_emails_by_recipient(recipients: List[str]) -> int:
    """Delete stored primitive mail for the exact recipient addresses listed.

    Primitive is a catch-all domain with no per-inbox object to delete —
    addresses are virtual — so benchmark cleanup removes the stored messages
    addressed to each minted recipient. Match recipients exactly so cleanup
    never sweeps mail for another minted address under the same domain.
    """
    api_key = load_env_var("PRIMITIVE_API_KEY", _BACKEND_ENV, _AGENTS_ENV)
    if not api_key:
        return 0

    base_url = load_env_var("PRIMITIVE_BASE_URL", _BACKEND_ENV, _AGENTS_ENV) or "https://api.primitive.dev/v1"
    base_url = base_url.rstrip("/")
    recipient_set = {recipient.strip().lower() for recipient in recipients if recipient.strip()}
    if not recipient_set:
        return 0
    headers = {"Authorization": f"Bearer {api_key}"}
    deleted = 0

    async with httpx.AsyncClient(timeout=30) as client:
        for recipient in sorted(recipient_set):
            list_response = await client.get(
                f"{base_url}/emails",
                params={"search": recipient, "limit": "100"},
                headers=headers,
            )
            if list_response.status_code == 404:
                continue
            if list_response.status_code != 200:
                raise RuntimeError(
                    f"Primitive benchmark mail list failed for {recipient}: "
                    f"HTTP {list_response.status_code} {list_response.text[:200]}"
                )
            payload = list_response.json()
            rows = payload.get("data") if isinstance(payload, dict) else []
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                if str(row.get("recipient") or "").strip().lower() != recipient:
                    continue
                email_id = str(row.get("id") or "").strip()
                if not email_id:
                    continue
                delete_response = await client.delete(
                    f"{base_url}/emails/{quote(email_id, safe='')}",
                    headers=headers,
                )
                if delete_response.status_code in (200, 202, 204, 404):
                    deleted += 1
                else:
                    raise RuntimeError(
                        f"Primitive benchmark mail cleanup failed for {recipient}: "
                        f"HTTP {delete_response.status_code} {delete_response.text[:200]}"
                    )
    return deleted


async def _delete_local_minted_primitive_mail_for_user(user_id: str) -> int:
    """Delete primitive mail referenced by local MintedAccount rows."""
    emails = _local_minted_account_labels_for_user(user_id)
    deleted = await _delete_primitive_emails_by_recipient(emails)
    print(f"    🧹 Deleted {deleted} primitive message(s) after minted benchmark run")
    return deleted


async def _primitive_inbox_has_uber_welcome(email: str) -> bool:
    """Return whether this exact minted address received Uber account-creation mail."""
    api_key = load_env_var("PRIMITIVE_API_KEY", _BACKEND_ENV, _AGENTS_ENV)
    if not api_key or not email.strip():
        return False

    base_url = load_env_var("PRIMITIVE_BASE_URL", _BACKEND_ENV, _AGENTS_ENV) or "https://api.primitive.dev/v1"
    base_url = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    target = email.strip().lower()

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base_url}/emails",
            params={"search": email.strip(), "limit": "20"},
            headers=headers,
        )
    if response.status_code == 404:
        return False
    if response.status_code != 200:
        raise RuntimeError(
            f"Primitive benchmark inbox evidence fetch failed for {email}: "
            f"HTTP {response.status_code} {response.text[:200]}"
        )

    data = response.json()
    rows = data.get("data") if isinstance(data, dict) else []
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("recipient") or "").strip().lower() != target:
            continue
        subject = str(row.get("subject") or "").lower()
        sender = str(row.get("sender") or "").lower()
        if "welcome to uber" in subject and "uber" in sender:
            return True
    return False


def _get_local_minted_account(user_id: str, auth_realm: str) -> Optional[dict]:
    sql = (
        'SELECT id, "accountLabel" FROM "MintedAccount" '
        f'WHERE "userId" = {_sql_literal(user_id)} AND "authRealm" = {_sql_literal(auth_realm)} '
        'AND "disabledAt" IS NULL LIMIT 1;'
    )
    out = _run_local_victoria_sql(sql)
    if not out:
        return None
    parts = out.splitlines()[0].split("\t")
    if len(parts) < 2:
        return None
    return {"id": parts[0], "account_label": parts[1]}


def _local_agent_phone_message_count_for_user(user_id: str) -> int:
    sql = f'SELECT COUNT(*) FROM "AgentPhoneMessage" WHERE "userId" = {_sql_literal(user_id)};'
    out = _run_local_victoria_sql(sql)
    try:
        return int(out.splitlines()[-1].strip() or "0")
    except Exception:
        return 0


async def _agentphone_messages_since_for_user(base_url: str, user_id: str, since: datetime) -> List[dict]:
    """Fetch AgentPhone messages through the same provider-polling path agents use."""
    api_key = load_env_var("BACKEND_API_KEY", _AGENTS_ENV, _BACKEND_ENV)
    if not api_key:
        return []

    since_iso = since.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base_url.rstrip('/')}/api/agentphone/messages",
            params={"since": since_iso, "limit": "50"},
            headers={"x-api-key": api_key, "x-user-id": user_id},
        )
    if response.status_code == 404:
        return []
    if response.status_code != 200:
        raise RuntimeError(
            f"AgentPhone benchmark evidence fetch failed: HTTP {response.status_code} {response.text[:200]}"
        )

    data = response.json()
    messages = data.get("messages") if isinstance(data, dict) else []
    return [message for message in messages if isinstance(message, dict)]


def _site_label_from_realm(auth_realm: str) -> str:
    labels = {
        "instagram.com": "Instagram",
        "x.com": "X",
        "uber.com": "Uber",
    }
    return labels.get(auth_realm, auth_realm)


def _task_result_search_text(result: TaskResult) -> str:
    chunks: List[str] = [
        result.failure_reason or "",
        result.status or "",
    ]
    logs = result.logs or {}
    for message in logs.get("messages", []) or []:
        if isinstance(message, dict):
            chunks.append(str(message.get("text") or message.get("message") or ""))
            metadata = message.get("metadata")
            if isinstance(metadata, dict):
                chunks.append(str(metadata.get("title") or ""))
    for key in ("backend_logs", "worker_logs", "research_logs", "realtime_logs"):
        for entry in logs.get(key, []) or []:
            chunks.append(str(entry))
    return "\n".join(chunks).lower()


def _agent_data_search_text(data: dict) -> str:
    """Collect agent message text for benchmark-specific terminal outcome checks."""
    chunks: List[str] = []
    for message in data.get("messages", []) or []:
        if isinstance(message, dict):
            chunks.append(str(message.get("text") or message.get("message") or ""))
            metadata = message.get("metadata")
            if isinstance(metadata, dict):
                chunks.append(str(metadata.get("title") or ""))
    return "\n".join(chunks).lower()


def _webdecoy_network_recording_paths(data: dict) -> List[Path]:
    # Flow: benchmark agent messages -> local network index -> FCaptcha response body -> exact risk score.
    paths: List[Path] = []
    seen: set[str] = set()

    def add_path(raw_path: object) -> None:
        if not isinstance(raw_path, str) or not raw_path.strip():
            return
        candidate = Path(raw_path.strip())
        if candidate.name == "index.html":
            candidate = candidate.parent / "network" / "index.json"
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            paths.append(candidate)

    def scan_metadata(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "network_recording_path":
                    add_path(child)
                else:
                    scan_metadata(child)
        elif isinstance(value, list):
            for child in value:
                scan_metadata(child)

    for message in data.get("messages", []) or []:
        if not isinstance(message, dict):
            continue
        scan_metadata(message.get("metadata"))
        text = str(message.get("text") or message.get("message") or "")
        for match in re.finditer(r"(/[^ \n\r\t]+/network/index\.json)", text):
            add_path(match.group(1))

    agent = data.get("agent", {}) or {}
    agent_id = agent.get("agent_id") or agent.get("agentId") or agent.get("id")
    if isinstance(agent_id, str) and agent_id:
        recordings_dir = REPO_ROOT / ".context" / "browser-agent-recordings" / agent_id
        if recordings_dir.exists():
            for index_path in sorted(recordings_dir.glob("*/network/index.json")):
                add_path(str(index_path))

    return paths


def _webdecoy_exact_score_from_network_log(index_path: Path) -> Optional[float]:
    if not index_path.exists():
        return None
    try:
        index = json.loads(index_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None

    scored_entries: List[Tuple[int, float]] = []
    entries = index.get("entries", [])
    if not isinstance(entries, list):
        return None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("url") or "")
        if "fcaptcha.webdecoy.com/api/score" not in url:
            continue
        if str(entry.get("method") or "").upper() != "POST":
            continue
        body_file = entry.get("body_file")
        if not isinstance(body_file, str) or not body_file:
            continue
        try:
            body = json.loads((index_path.parent / body_file).read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(body, dict):
            continue
        if body.get("action") not in (None, "form_submit"):
            continue
        score = body.get("score")
        if isinstance(score, (int, float)):
            scored_entries.append((int(entry.get("response_ts_ms") or entry.get("request_ts_ms") or 0), float(score)))

    if not scored_entries:
        return None
    scored_entries.sort(key=lambda item: item[0])
    return scored_entries[-1][1]


def _webdecoy_engine_version_from_network_log(index_path: Path) -> Optional[str]:
    """Read the FCaptcha engine version the demo page advertised ("Running vX.Y.Z").

    The gated score is produced by a third-party detector we do not control, so a
    vendor release can move it with no change on our side. Capturing the version
    next to the score is what makes those two cases distinguishable after the fact.
    """
    if not index_path.exists():
        return None
    try:
        index = json.loads(index_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None

    entries = index.get("entries", [])
    if not isinstance(entries, list):
        return None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if "webdecoy.com/product/fcaptcha-demo" not in str(entry.get("url") or ""):
            continue
        body_file = entry.get("body_file")
        if not isinstance(body_file, str) or not body_file:
            continue
        try:
            body = (index_path.parent / body_file).read_text(errors="replace")
        except OSError:
            continue
        match = re.search(r"Running v([0-9]+(?:\.[0-9]+)*)", body)
        if match:
            return match.group(1)
    return None


def _webdecoy_engine_version_from_recordings(data: dict) -> Optional[str]:
    for index_path in _webdecoy_network_recording_paths(data):
        version = _webdecoy_engine_version_from_network_log(index_path)
        if version is not None:
            return version
    return None


def _webdecoy_exact_score_from_recordings(data: dict) -> Optional[float]:
    scores: List[float] = []
    for index_path in _webdecoy_network_recording_paths(data):
        score = _webdecoy_exact_score_from_network_log(index_path)
        if score is not None:
            scores.append(score)
    if not scores:
        return None
    return scores[-1]


def _webdecoy_verify_detections(data: dict) -> Optional[List[str]]:
    """``category: reason`` of every captured FCaptcha ``/api/verify`` response, in order.

    ``/api/score`` answers with the bare score; the detections behind it arrive on
    the verify responses. A flag can fire on one verify and not the next (the
    2026-11-04 datacenter exit only showed on the first), so keep them all.
    """
    responses: List[Tuple[int, List[str]]] = []
    for index_path in _webdecoy_network_recording_paths(data):
        try:
            entries = json.loads(index_path.read_text()).get("entries", [])
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict) or "fcaptcha.webdecoy.com/api/verify" not in str(entry.get("url") or ""):
                continue
            body_file = entry.get("body_file")
            if str(entry.get("method") or "").upper() != "POST" or not isinstance(body_file, str) or not body_file:
                continue
            try:
                body = json.loads((index_path.parent / body_file).read_text())
            except (OSError, json.JSONDecodeError):
                continue
            detections = body.get("detections") if isinstance(body, dict) else None
            if not isinstance(detections, list):
                continue
            reasons = [
                f"{item.get('category')}: {item.get('reason')}"
                for item in detections
                if isinstance(item, dict) and item.get("reason")
            ]
            responses.append((int(entry.get("response_ts_ms") or entry.get("request_ts_ms") or 0), reasons))
    if not responses:
        return None
    ordered: List[str] = []
    for _ts, reasons in sorted(responses, key=lambda item: item[0]):
        ordered.extend(reason for reason in reasons if reason not in ordered)
    return ordered


def _webdecoy_browser_session(data: dict) -> Dict[str, Any]:
    """Provider and exit of the terminal browser session the score was measured on."""
    session: Dict[str, Any] = {}
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        browser = metadata.get("browser_session_metadata") if isinstance(metadata, dict) else None
        if isinstance(browser, dict) and browser.get("provider"):
            session = {"provider": browser.get("provider"), "proxy_source": browser.get("proxy_source")}
    return session


def _webdecoy_score_evidence(data: dict) -> Dict[str, Any]:
    """Everything needed to compare one FCaptcha score with another, pass or fail.

    The gated number comes from a third-party detector and depends on the browser
    provider/exit as much as on our input synthesis, so every attempt records the
    score, the engine version, the detections behind it and the browser session.
    """
    exact_score = _webdecoy_exact_score_from_recordings(data)
    structured_score = _webdecoy_structured_score(data)
    visible_scores = _webdecoy_visible_risk_scores(_agent_data_search_text(data))
    if exact_score is not None:
        score, source = exact_score, "captured API"
    elif structured_score is not None:
        score, source = structured_score, "structured output"
    elif visible_scores:
        score, source = visible_scores[-1], "visible"
    else:
        score, source = None, None
    session = _webdecoy_browser_session(data)
    return {
        "fcaptcha_score": score,
        "fcaptcha_score_source": source,
        "fcaptcha_engine_version": _webdecoy_engine_version_from_recordings(data),
        "fcaptcha_detections": _webdecoy_verify_detections(data),
        "browser_provider": session.get("provider"),
        "browser_proxy_source": session.get("proxy_source"),
    }


def _webdecoy_parse_score_value(raw_score: object) -> Optional[float]:
    """Parse a structured FCaptcha risk score (numeric or numeric string)."""
    if isinstance(raw_score, bool):
        return None
    if isinstance(raw_score, (int, float)):
        return float(raw_score)
    if isinstance(raw_score, str):
        match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*", raw_score)
        if match is not None:
            return float(match.group(1))
    return None


def _webdecoy_structured_score(data: dict) -> Optional[float]:
    """Read the terminal browser task's grounded FCaptcha score."""
    scores: List[float] = []
    for message in data.get("messages", []) or []:
        if not isinstance(message, dict) or message.get("role") != "TOOL":
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if (
            metadata.get("toolName") != "spawn_browser_agent"
            or metadata.get("toolStatus") != "FINISHED"
            or metadata.get("action_type") != "task_complete"
        ):
            continue
        structured = metadata.get("structured_response") or metadata.get("structuredResponse")
        if not isinstance(structured, dict):
            continue
        # Schema field is fcaptcha_risk_score; risk_score kept for older fixtures.
        raw_score = structured.get("fcaptcha_risk_score")
        if raw_score is None:
            raw_score = structured.get("risk_score")
        parsed = _webdecoy_parse_score_value(raw_score)
        if parsed is not None:
            scores.append(parsed)
    if not scores:
        return None
    return scores[-1]


def _webdecoy_visible_risk_scores(text: str) -> list[float]:
    """Extract visible FCaptcha risk scores from agent transcript text.

    Rejects numbered-list false positives like "(3) Risk score: ..." where the
    list ordinal would otherwise become scores[-1] and fail the ratchet gate.
    """
    score_patterns = (
        # "Risk Score (lower = human): 0.00" / "risk score:** 0.09"
        r"risk\s*score[^0-9]{0,24}([0-9]+(?:\.[0-9]+)?)",
        # "0.09 risk score" — require a decimal so list ordinals ("3) Risk score")
        # cannot match.
        r"([0-9]+\.[0-9]+)\s*[^a-z0-9]{0,12}risk\s*score",
    )
    scores: list[float] = []
    for pattern in score_patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            try:
                scores.append(float(match.group(1)))
            except ValueError:
                continue
    return scores


def _evaluate_webdecoy_biometrics_result(data: dict) -> Tuple[bool, Optional[str]]:
    text = _agent_data_search_text(data)
    if "webdecoy.com/product/fcaptcha-demo" not in text and "fcaptcha" not in text:
        return False, "No grounded evidence that the WebDecoy FCaptcha demo was visited"
    if not any(marker in text for marker in ("click", "clicked", "checkbox")):
        return False, "No grounded evidence of checkbox interaction"
    if not any(marker in text for marker in ("benchmark-human@example.com", "invisible mode", "submit")):
        return False, "No grounded evidence of invisible-mode form interaction"

    scores = _webdecoy_visible_risk_scores(text)

    exact_score = _webdecoy_exact_score_from_recordings(data)
    structured_score = _webdecoy_structured_score(data)
    if exact_score is None and structured_score is None and not scores:
        return False, "No FCaptcha risk score was reported"

    if exact_score is not None:
        final_score = exact_score
        score_source = "captured API"
    elif structured_score is not None:
        final_score = structured_score
        score_source = "structured output"
    else:
        final_score = scores[-1]
        score_source = "visible"
    # RATCHET gate (lower = more human). Literal 0.00 is unreachable while Steel's
    # managed proxy injects x-forwarded-for/x-real-ip/cf-connecting-ip headers
    # (the `bot` 0.30 signal) — that needs a clean residential BYOP proxy, which
    # is infrastructure, not code. 0.157 was the genuine achieved floor after the
    # anti-detection work (cdp/webdriver/vision_ai driven to 0; the detector's own
    # verdict at this score is "allow"). This threshold is a RATCHET: drive it
    # DOWN as anti-detection improves (clean proxy, canvas, per-session fp).
    # Raised to 0.160 on 2026-06-28 with explicit human approval to absorb the
    # ~0.003 run-to-run variance in the behavioral-biometrics score (mouse timing,
    # Steel proxy, parallel-run CPU/PoW contention); resume ratcheting DOWN as the
    # anti-detection floor improves.
    # Raised to 0.163 on 2026-07-01 with explicit human approval: three consecutive
    # runs (parallel + two solo) all scored a deterministic 0.163 with no related
    # code change — the current external anti-bot floor (Steel proxy IP reputation)
    # sits 0.003 above the prior ratchet. Resume ratcheting DOWN as the floor improves.
    WEBDECOY_RISK_RATCHET = 0.163
    # Engine version is diagnostic only — it NEVER relaxes the comparison above.
    # It exists so a vendor recalibration is visible in the failure line instead of
    # being misread as an anti-detection regression on our side. Reference points:
    # FCaptcha v1.14.0/v1.15.0 scored a bit-identical 0.15595 across 14 runs and 13
    # distinct egress IPs (2026-07-18..07-26); the v1.18.0 release moved the same
    # unchanged client to 0.18296 while every reported categoryScore sat at 0.
    if final_score > WEBDECOY_RISK_RATCHET:
        evidence = _webdecoy_score_evidence(data)
        engine_version = evidence["fcaptcha_engine_version"]
        version_note = (
            f" [FCaptcha engine v{engine_version}; a version change here means the third-party"
            f" detector was recalibrated — compare against the version on the last passing run"
            f" before treating this as an anti-detection regression]"
            if engine_version
            else ""
        )
        detections = evidence["fcaptcha_detections"]
        evidence_note = (
            f" [detections: {'; '.join(detections) if detections else 'none captured'}"
            f"; browser {evidence['browser_provider'] or 'unknown'}/{evidence['browser_proxy_source'] or 'unknown'}]"
        )
        return False, (
            f"FCaptcha {score_source} risk score {final_score:.3f} exceeds ratchet {WEBDECOY_RISK_RATCHET:.3f} "
            f"(lower = more human; this gate only ratchets down, never up){version_note}{evidence_note}"
        )
    return True, None


def _x_signup_has_terminal_phone_blocker(signup_text: str) -> bool:
    """Return true when X forced phone auth and rejected it before account creation.

    The X post prompt embeds guidance that names these failure modes (including the
    exact phrase "terminal phone-auth blocker"). `_task_result_search_text` includes
    USER/spawn-goal text, so matching the raw blob false-positives every successful
    run. Strip the stock auth hint / post prompt before scanning for outcome markers.
    """
    normalized = (signup_text or "").lower()
    for stock in (
        MINTED_AGENT_ACCOUNT_X_AUTH_HINT.lower(),
        _x_post_prompt().lower(),
        MINTED_AGENT_ACCOUNT_X_POST_GOAL.lower(),
    ):
        if stock:
            normalized = normalized.replace(stock, " ")
    return any(
        marker in normalized
        for marker in (
            "terminal phone-auth blocker",
            "terminal phone auth blocker",
            "an unexpected error occurred",
            "invalid number",
            "fails to send sms",
            "failed to send sms",
            "phone number is blocked",
        )
    )


def _x_signup_has_account_creation_evidence(signup_text: str) -> bool:
    """Return true when the signup task produced grounded X account access evidence."""
    normalized = signup_text.lower()
    return any(
        marker in normalized
        for marker in (
            "signed in",
            "account creation completed",
            "account created",
            "account is signed in",
            "post composer",
            "home timeline",
        )
    )


def _default_minted_target_url(base_url: str, task_name: str = MINTED_AGENT_ACCOUNT_X_TASK_NAME) -> str:
    if task_name == MINTED_AGENT_ACCOUNT_X_TASK_NAME:
        return "https://x.com"
    return f"{base_url.rstrip('/')}/api/test/minted-agent-account-fixture?authRealm=m.uber.com"


def _auth_realm_from_target_url(target_url: str) -> str:
    parsed = urlparse(target_url if target_url.startswith(("http://", "https://")) else f"https://{target_url}")
    if (parsed.hostname or "").lower() in {"localhost", "127.0.0.1"}:
        query = dict(part.split("=", 1) for part in parsed.query.split("&") if "=" in part)
        override = query.get("authRealm") or query.get("auth_realm")
        if override:
            return _auth_realm_from_target_url(override)
    host = (parsed.hostname or parsed.netloc or parsed.path).split("/")[0].lower()
    if host.startswith("www."):
        host = host[4:]
    if host == "uber.com" or host.endswith(".uber.com"):
        return "uber.com"
    return host


def _auth_bundle_biometrics_gate_enabled() -> bool:
    raw = os.environ.get(AUTH_BUNDLE_BIOMETRICS_GATE_ENV)
    if raw is None or raw == "":
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off", "disabled"}


async def _run_auth_bundle_biometrics_gate(
    base_url: str,
    keep_failed_agents: bool,
    on_agent_created: Optional[Callable[[str, str], None]] = None,
) -> TaskResult:
    """Run the most sensitive public biometrics score gate before auth-bundle probes."""
    gate_task = get_task_by_name(BIOMETRICS_WEBDECOY_TASK_NAME)
    print("    🧬 Auth bundle biometrics gate: WebDecoy FCaptcha score must be 0.00")
    return await run_single_task(
        base_url,
        gate_task,
        keep_failed_agents=keep_failed_agents,
        on_agent_created=on_agent_created,
    )


def _aggregate_benchmark_status(passed: bool, *results: TaskResult) -> str:
    """Preserve child harness failures when grading a composite benchmark."""
    for result in results:
        outcome = result.benchmark_status if result.benchmark_status is not None else result.status
        if not isinstance(outcome, str):
            return "ERROR"
        outcome = outcome.upper()
        if outcome not in {"PASSED", "FAILED", "SKIPPED", "ERROR", "CANCELLED", "INFRA_ERROR"}:
            return "ERROR"
        if type(result.passed) is not bool or result.passed != (outcome == "PASSED"):
            return "ERROR"
        if outcome in {"ERROR", "CANCELLED", "INFRA_ERROR"}:
            return outcome
    return "PASSED" if passed else "FAILED"


async def run_minted_agent_account_task(
    base_url: str,
    task: BenchmarkTask,
    keep_failed_agents: bool = False,
    on_agent_created: Optional[Callable[[str, str], None]] = None,
) -> TaskResult:
    """Run the stateful minted-account benchmark: signup task, DB assertion, booking task."""
    if "localhost" not in base_url and "127.0.0.1" not in base_url:
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id="",
            status="SKIPPED",
            benchmark_status="SKIPPED",
            progress_score=0,
            duration_seconds=0,
            cost_cents=0,
            message_count=0,
            failure_reason="Minted account benchmark is local-only because it deletes local DB rows.",
        )

    def remember_owned_root(_stage_name: str, agent_id: str) -> None:
        if on_agent_created is not None:
            on_agent_created(task.name, agent_id)

    start = time.time()
    target_url = os.environ.get("BENCHMARK_MINTED_TARGET_URL") or _default_minted_target_url(base_url, task.name)
    target_realm = os.environ.get("BENCHMARK_MINTED_AUTH_REALM") or _auth_realm_from_target_url(target_url)
    site_label = _site_label_from_realm(target_realm)
    reset_agent_identity = os.environ.get("BENCHMARK_MINTED_RESET_AGENT_IDENTITY", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    prefer_phone_auth = _benchmark_env_bool("BENCHMARK_MINTED_PREFER_PHONE_AUTH") is True
    # Live X Hello World reuses the synced CookieBundle and grades write-lock
    # notification semantics — clearing auth forces mint/signup noise. Other
    # minted realms still clear by default. Override either path with
    # BENCHMARK_MINTED_CLEAR_EXISTING_AUTH.
    clear_existing_auth = (
        _minted_x_clear_existing_auth_enabled() if target_realm == "x.com" else _minted_clear_existing_auth_enabled()
    )
    phone_evidence_since = datetime.now(timezone.utc)
    identity_was_present = _local_agent_identity_present_for_user(USER_ID)
    deleted = _delete_local_minted_accounts_for_user(USER_ID, reset_agent_identity=reset_agent_identity)
    seeded_identity_email = None if reset_agent_identity else _seed_local_benchmark_agent_identity_if_missing(USER_ID)
    disabled_auth = _disable_local_auth_material_for_realm(USER_ID, target_realm) if clear_existing_auth else 0
    print(
        f"    🧹 Deleted {deleted} minted account row(s), "
        f"{'reset' if reset_agent_identity else 'preserved'} cached AgentIdentity "
        f"(present_before={identity_was_present})"
    )
    if seeded_identity_email:
        print(f"    🧪 Seeded cached AgentIdentity for local benchmark: {seeded_identity_email}")
    if clear_existing_auth:
        print(f"    🧹 Disabled {disabled_auth} saved auth row(s) for {target_realm}")
    if prefer_phone_auth:
        print("    ☎️  Minted benchmark auth preference: AgentPhone first")

    auth_bundle_biometrics_result: Optional[TaskResult] = None
    if _auth_bundle_biometrics_gate_enabled():
        auth_bundle_biometrics_result = await _run_auth_bundle_biometrics_gate(
            base_url,
            keep_failed_agents,
            on_agent_created=remember_owned_root,
        )
        if not auth_bundle_biometrics_result.passed:
            benchmark_status = _aggregate_benchmark_status(False, auth_bundle_biometrics_result)
            passed = benchmark_status == "PASSED"
            return TaskResult(
                name=task.name,
                passed=passed,
                agent_id=auth_bundle_biometrics_result.agent_id,
                status="FAILED",
                benchmark_status=benchmark_status,
                progress_score=auth_bundle_biometrics_result.progress_score,
                duration_seconds=round(time.time() - start, 1),
                cost_cents=auth_bundle_biometrics_result.cost_cents,
                message_count=auth_bundle_biometrics_result.message_count,
                failure_reason=(
                    "auth bundle biometrics gate failed: "
                    f"{auth_bundle_biometrics_result.failure_reason or auth_bundle_biometrics_result.status}"
                ),
                approvals_triggered=auth_bundle_biometrics_result.approvals_triggered,
                approvals_resolved=auth_bundle_biometrics_result.approvals_resolved,
                cache_read_input_tokens=auth_bundle_biometrics_result.cache_read_input_tokens,
                cache_creation_input_tokens=auth_bundle_biometrics_result.cache_creation_input_tokens,
                cache_hit_pct=auth_bundle_biometrics_result.cache_hit_pct,
                fast_mode_cache_enabled=auth_bundle_biometrics_result.fast_mode_cache_enabled,
                context_violations=auth_bundle_biometrics_result.context_violations,
                logs={"auth_bundle_biometrics": auth_bundle_biometrics_result.logs},
            )
    else:
        print(f"    🧬 Auth bundle biometrics gate disabled by {AUTH_BUNDLE_BIOMETRICS_GATE_ENV}")

    def _with_gate_agent_ids(*agent_ids: str) -> str:
        gate_agent_id = auth_bundle_biometrics_result.agent_id if auth_bundle_biometrics_result else ""
        return ",".join(filter(None, [gate_agent_id, *agent_ids]))

    def _with_gate_cost(*costs: float) -> float:
        gate_cost = auth_bundle_biometrics_result.cost_cents if auth_bundle_biometrics_result else 0
        return round(gate_cost + sum(costs), 2)

    def _with_gate_message_count(*counts: int) -> int:
        gate_count = auth_bundle_biometrics_result.message_count if auth_bundle_biometrics_result else 0
        return gate_count + sum(counts)

    def _with_gate_cache_read(*counts: int) -> int:
        gate_count = auth_bundle_biometrics_result.cache_read_input_tokens if auth_bundle_biometrics_result else 0
        return gate_count + sum(counts)

    def _with_gate_cache_creation(*counts: int) -> int:
        gate_count = auth_bundle_biometrics_result.cache_creation_input_tokens if auth_bundle_biometrics_result else 0
        return gate_count + sum(counts)

    def _with_gate_context_violations(*violations: List[dict]) -> List[dict]:
        gate_violations = auth_bundle_biometrics_result.context_violations if auth_bundle_biometrics_result else []
        merged = list(gate_violations)
        for chunk in violations:
            merged.extend(chunk)
        return merged

    def _with_gate_progress(*scores: float) -> float:
        gate_score = auth_bundle_biometrics_result.progress_score if auth_bundle_biometrics_result else 1
        return min([gate_score, *scores])

    def _with_gate_logs(logs: dict) -> dict:
        if auth_bundle_biometrics_result is None:
            return logs
        return {"auth_bundle_biometrics": auth_bundle_biometrics_result.logs, **logs}

    def _with_gate_fast_mode(*results: TaskResult) -> bool:
        gate_enabled = auth_bundle_biometrics_result.fast_mode_cache_enabled if auth_bundle_biometrics_result else False
        return gate_enabled or any(result.fast_mode_cache_enabled for result in results)

    if target_realm == "x.com":
        post_task = replace(
            task,
            name=f"{task.name}-post",
            title="Live X Hello World Post",
            prompt=_x_post_prompt(),
            approval_handling=task.approval_handling or "auto_approve",
            expected_attention_kind=task.expected_attention_kind or "write_lock",
            expected_approval_count=(task.expected_approval_count if task.expected_approval_count is not None else 1),
            timeout_seconds=max(task.timeout_seconds, 900),
        )
        previous_write_lock = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "true"
        try:
            post_result = await run_single_task(
                base_url,
                post_task,
                keep_failed_agents=keep_failed_agents,
                on_agent_created=remember_owned_root,
            )
        finally:
            if previous_write_lock is None:
                del os.environ["BENCHMARK_WRITE_LOCK_ENABLED"]
            else:
                os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = previous_write_lock

        minted = _get_local_minted_account(USER_ID, target_realm)
        if minted:
            print(f"    ℹ️ MintedAccount present for {target_realm} (not required): {minted['account_label']}")
        else:
            print(f"    ℹ️ No MintedAccount for {target_realm} (not required for live-auth X post)")
        post_text = _task_result_search_text(post_result)
        passed, failure_parts = _grade_live_x_hello_world_post(
            post_passed=post_result.passed,
            post_failure_reason=post_result.failure_reason,
            post_status=post_result.status,
            post_text=post_text,
        )
        benchmark_status = _aggregate_benchmark_status(passed, post_result)
        passed = benchmark_status == "PASSED"
        return TaskResult(
            name=task.name,
            passed=passed,
            agent_id=_with_gate_agent_ids(post_result.agent_id),
            status="COMPLETED" if passed else "FAILED",
            benchmark_status=benchmark_status,
            progress_score=_with_gate_progress(post_result.progress_score),
            duration_seconds=round(time.time() - start, 1),
            cost_cents=_with_gate_cost(post_result.cost_cents),
            message_count=_with_gate_message_count(post_result.message_count),
            failure_reason=" | ".join(failure_parts) if failure_parts else None,
            approvals_triggered=post_result.approvals_triggered,
            approvals_resolved=post_result.approvals_resolved,
            cache_read_input_tokens=_with_gate_cache_read(post_result.cache_read_input_tokens),
            cache_creation_input_tokens=_with_gate_cache_creation(post_result.cache_creation_input_tokens),
            cache_hit_pct=post_result.cache_hit_pct,
            fast_mode_cache_enabled=_with_gate_fast_mode(post_result),
            context_violations=_with_gate_context_violations(post_result.context_violations),
            logs=_with_gate_logs({"post": post_result.logs}),
        )

    signup_auth_instruction = (
        f"Use the minted AgentPhone number for {site_label}'s initial phone/email/login field. Do not use "
        f"the minted email unless {site_label} accepts the phone number first and then explicitly "
        f"asks for an email address as an additional account field. Before typing into {site_label}'s "
        "phone/email field, clear the field completely; do not append the phone and email together. "
        f"If {site_label} explicitly says the minted phone number is blocked or unsupported, stop and report "
        "that phone-auth blocker. If a verification code is sent by SMS, wait for the recent OTP "
        "from the available phone context and use it. "
        if prefer_phone_auth
        else f"Use the minted email for {site_label}'s initial phone/email login field when an "
        f"email address is accepted. Use the minted AgentPhone number only if {site_label} explicitly "
        "requires a phone number or SMS verification. Do not use any other email or phone. Before "
        f"typing into {site_label}'s phone/email field, clear the field completely; do not append the phone "
        f"and email together. If {site_label} explicitly says the minted phone number is blocked, choose "
        "another available login option using the minted email; stop and report the "
        "blocker only if no minted-email path is available. If a verification code is sent by SMS or "
        "email, wait for the recent OTP from the available phone/email context and use it. "
    )
    if target_realm == "x.com" and not prefer_phone_auth:
        signup_auth_instruction += (
            "For X specifically, create a new account through the signup flow and choose the email "
            "signup route. Click controls like 'Use email instead' when they are available. Do not click "
            "'Sign up with Phone' or 'Continue with phone' unless X leaves no email signup path. If X "
            "forces a phone number after the email route, use the minted AgentPhone number exactly once. "
            "If X then shows 'An unexpected error occurred', treats the number as invalid, or fails to "
            "send an SMS, stop and report that as a terminal phone-auth blocker instead of retrying "
            "alternate phone formats. "
        )
    signup_prompt = (
        f"Open {target_url}. Create or sign in to the {site_label} account using the agent minted "
        f"identity shown in auth options. {signup_auth_instruction}"
        "If the site asks for a full name, username, birthday, or password while creating an account, "
        "use non-personal agent account values derived from the agent name plus a random keyword and "
        "two digits, and use a fresh strong password. Stop only after the site shows the account is "
        "signed in, account creation completed, a recent SMS OTP was received and used, or the site "
        "shows a terminal phone-auth blocker. "
        f"{'Do not book a ride in this task.' if target_realm == 'uber.com' else 'Do not perform unrelated actions after the auth result is clear.'}"
    )
    signup_task = replace(
        task,
        name=f"{task.name}-signup",
        title="Minted Agent Account Signup",
        prompt=signup_prompt,
        approval_handling=None,
        expected_attention_kind=None,
        expected_attention_kinds=[],
        evaluators=[],
        enforce_declared_evaluators=False,
        timeout_seconds=max(task.timeout_seconds, 900),
    )
    try:
        previous_signup_write_lock = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "false"
        try:
            signup_result = await run_single_task(
                base_url,
                signup_task,
                keep_failed_agents=keep_failed_agents,
                on_agent_created=remember_owned_root,
            )
        finally:
            if previous_signup_write_lock is None:
                del os.environ["BENCHMARK_WRITE_LOCK_ENABLED"]
            else:
                os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = previous_signup_write_lock
        minted = _get_local_minted_account(USER_ID, target_realm)
        if minted:
            print(f"    ✅ Minted account persisted for {target_realm}: {minted['account_label']}")
        else:
            print(f"    ❌ No minted account persisted for {target_realm}")
        signup_account_evidence = False
        if minted and target_realm == "uber.com":
            signup_account_evidence = await _primitive_inbox_has_uber_welcome(minted["account_label"])
            if signup_account_evidence:
                print("    ✅ Uber account creation evidence found in primitive welcome email")
            else:
                print("    ❌ No Uber account creation evidence found in primitive mail")

        if target_realm == "x.com":
            signup_text = _task_result_search_text(signup_result)
            x_terminal_phone_blocker = _x_signup_has_terminal_phone_blocker(signup_text)
            x_account_access_proven = _x_signup_has_account_creation_evidence(signup_text)
            if x_terminal_phone_blocker or not x_account_access_proven or minted is None or not signup_result.passed:
                failure_parts = []
                if minted is None:
                    failure_parts.append(f"no MintedAccount row for {target_realm}")
                if x_terminal_phone_blocker:
                    failure_parts.append("X forced phone auth and returned a terminal phone-auth blocker")
                if not x_account_access_proven:
                    failure_parts.append("no grounded evidence that X account creation/sign-in completed")
                if not signup_result.passed:
                    failure_parts.append(
                        f"signup/auth probe failed: {signup_result.failure_reason or signup_result.status}"
                    )
                benchmark_status = _aggregate_benchmark_status(False, signup_result)
                passed = benchmark_status == "PASSED"
                return TaskResult(
                    name=task.name,
                    passed=passed,
                    agent_id=_with_gate_agent_ids(signup_result.agent_id),
                    status="FAILED",
                    benchmark_status=benchmark_status,
                    progress_score=_with_gate_progress(signup_result.progress_score),
                    duration_seconds=round(time.time() - start, 1),
                    cost_cents=_with_gate_cost(signup_result.cost_cents),
                    message_count=_with_gate_message_count(signup_result.message_count),
                    failure_reason=" | ".join(failure_parts),
                    approvals_triggered=signup_result.approvals_triggered,
                    approvals_resolved=signup_result.approvals_resolved,
                    cache_read_input_tokens=_with_gate_cache_read(signup_result.cache_read_input_tokens),
                    cache_creation_input_tokens=_with_gate_cache_creation(signup_result.cache_creation_input_tokens),
                    cache_hit_pct=signup_result.cache_hit_pct,
                    fast_mode_cache_enabled=_with_gate_fast_mode(signup_result),
                    context_violations=_with_gate_context_violations(signup_result.context_violations),
                    logs=_with_gate_logs({"signup": signup_result.logs}),
                )

            post_auth_instruction = (
                "If X asks for login again, use the minted email in the phone/email field "
                "when email is accepted; use the minted AgentPhone number only if X explicitly requires "
                "phone/SMS auth. Clear the phone/email input before each attempt. If a verification code "
                "is sent by SMS or email, wait for the recent OTP from the available phone/email context "
                "and use it. "
            )
            post_prompt = (
                f"Open {target_url}. Using the already-created X account in this browser profile, "
                "create a new public post with exactly this text: hello world! "
                "Confirm the page is signed in with the same agent minted identity from the first task. "
                f"{post_auth_instruction}"
                "Submit the post. The benchmark has explicitly authorized this exact post, so if the "
                "browser write-lock asks for approval on the final Post button, wait for the approval "
                "to be granted and then finish only after the post is submitted or X shows a clear "
                "terminal blocker."
            )
            post_task = replace(
                task,
                name=f"{task.name}-post",
                title="Minted Agent Account X Post",
                prompt=post_prompt,
                approval_handling="auto_approve",
                expected_attention_kind="write_lock",
                timeout_seconds=max(task.timeout_seconds, 900),
            )
            previous_write_lock = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
            os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "true"
            try:
                post_result = await run_single_task(
                    base_url,
                    post_task,
                    keep_failed_agents=keep_failed_agents,
                    on_agent_created=remember_owned_root,
                )
            finally:
                if previous_write_lock is None:
                    del os.environ["BENCHMARK_WRITE_LOCK_ENABLED"]
                else:
                    os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = previous_write_lock

            post_text = _task_result_search_text(post_result)
            post_evidence = "hello world" in post_text and any(
                marker in post_text
                for marker in ("posted", "post submitted", "post was submitted", "successfully posted")
            )
            x_terminal_phone_blocker = _x_signup_has_terminal_phone_blocker(post_text)
            passed = (
                x_account_access_proven
                and minted is not None
                and post_result.passed
                and post_evidence
                and not x_terminal_phone_blocker
            )
            failure_parts = []
            if not x_account_access_proven:
                failure_parts.append(f"signup failed: {signup_result.failure_reason or signup_result.status}")
            if minted is None:
                failure_parts.append(f"no MintedAccount row for {target_realm}")
            if x_terminal_phone_blocker:
                failure_parts.append("X forced phone auth and returned a terminal phone-auth blocker")
            if not post_result.passed:
                failure_parts.append(f"post failed: {post_result.failure_reason or post_result.status}")
            if post_result.passed and not post_evidence and not x_terminal_phone_blocker:
                failure_parts.append("no grounded evidence that the hello world post was submitted")

            benchmark_status = _aggregate_benchmark_status(passed, signup_result, post_result)
            passed = benchmark_status == "PASSED"
            return TaskResult(
                name=task.name,
                passed=passed,
                agent_id=_with_gate_agent_ids(signup_result.agent_id, post_result.agent_id),
                status="COMPLETED" if passed else "FAILED",
                benchmark_status=benchmark_status,
                progress_score=_with_gate_progress(signup_result.progress_score, post_result.progress_score),
                duration_seconds=round(time.time() - start, 1),
                cost_cents=_with_gate_cost(signup_result.cost_cents, post_result.cost_cents),
                message_count=_with_gate_message_count(signup_result.message_count, post_result.message_count),
                failure_reason=" | ".join(failure_parts) if failure_parts else None,
                approvals_triggered=post_result.approvals_triggered,
                approvals_resolved=post_result.approvals_resolved,
                cache_read_input_tokens=_with_gate_cache_read(
                    signup_result.cache_read_input_tokens,
                    post_result.cache_read_input_tokens,
                ),
                cache_creation_input_tokens=_with_gate_cache_creation(
                    signup_result.cache_creation_input_tokens,
                    post_result.cache_creation_input_tokens,
                ),
                cache_hit_pct=0.0,
                fast_mode_cache_enabled=_with_gate_fast_mode(signup_result, post_result),
                context_violations=_with_gate_context_violations(
                    signup_result.context_violations,
                    post_result.context_violations,
                ),
                logs=_with_gate_logs({"signup": signup_result.logs, "post": post_result.logs}),
            )

        if target_realm != "uber.com":
            phone_messages = await _agentphone_messages_since_for_user(base_url, USER_ID, phone_evidence_since)
            phone_message_delta = len(phone_messages)
            signup_text = _task_result_search_text(signup_result)
            phone_blocked = (
                "phone number you entered is blocked" in signup_text
                or ("phone" in signup_text and "blocked" in signup_text)
                or ("phone" in signup_text and "unsupported" in signup_text)
            )
            auth_completed = any(
                marker in signup_text
                for marker in (
                    "signed in",
                    "account creation completed",
                    "account created",
                    "verification code",
                    "otp",
                )
            )
            phone_auth_proven = phone_message_delta > 0 or auth_completed
            passed = minted is not None and signup_result.passed and phone_auth_proven and not phone_blocked
            failure_parts = []
            if minted is None:
                failure_parts.append(f"no MintedAccount row for {target_realm}")
            if phone_blocked:
                failure_parts.append(f"{site_label} blocked or rejected the minted AgentPhone number")
            if not phone_auth_proven:
                failure_parts.append("no SMS OTP, verification, sign-in, or account-creation evidence observed")
            if not signup_result.passed:
                failure_parts.append(
                    f"signup/auth probe failed: {signup_result.failure_reason or signup_result.status}"
                )
            if phone_message_delta > 0:
                print(f"    ✅ AgentPhone received {phone_message_delta} new message(s) during {site_label} auth")
            else:
                print(f"    ❌ AgentPhone received no new messages during {site_label} auth")

            benchmark_status = _aggregate_benchmark_status(passed, signup_result)
            passed = benchmark_status == "PASSED"
            return TaskResult(
                name=task.name,
                passed=passed,
                agent_id=_with_gate_agent_ids(signup_result.agent_id),
                status="COMPLETED" if passed else "FAILED",
                benchmark_status=benchmark_status,
                progress_score=_with_gate_progress(signup_result.progress_score),
                duration_seconds=round(time.time() - start, 1),
                cost_cents=_with_gate_cost(signup_result.cost_cents),
                message_count=_with_gate_message_count(signup_result.message_count),
                failure_reason=" | ".join(failure_parts) if failure_parts else None,
                approvals_triggered=signup_result.approvals_triggered,
                approvals_resolved=signup_result.approvals_resolved,
                cache_read_input_tokens=_with_gate_cache_read(signup_result.cache_read_input_tokens),
                cache_creation_input_tokens=_with_gate_cache_creation(signup_result.cache_creation_input_tokens),
                cache_hit_pct=signup_result.cache_hit_pct,
                fast_mode_cache_enabled=_with_gate_fast_mode(signup_result),
                context_violations=_with_gate_context_violations(signup_result.context_violations),
                logs=_with_gate_logs(
                    {
                        "signup": signup_result.logs,
                        "phone_message_delta": phone_message_delta,
                        "phone_messages": phone_messages,
                    }
                ),
            )

        booking_auth_instruction = (
            "If Uber asks for login again, use the minted AgentPhone number in the phone/email field. "
            "Do not switch to the minted email unless Uber accepts the phone number first and then explicitly "
            "asks for an email address as an additional account field. Clear the phone/email input "
            "before each attempt. If Uber says the minted phone number is blocked or unsupported, stop "
            "and report that phone-auth blocker. "
            if prefer_phone_auth
            else "If Uber asks for login again, use the minted email in the phone/email field "
            "when email is accepted; use the minted AgentPhone number only if Uber explicitly requires "
            "phone/SMS auth. Clear the phone/email input before each attempt. If Uber says the minted "
            "phone number is blocked, choose another available login option using the minted "
            "email; stop and report the blocker only if no minted-email path is available. "
        )
        booking_prompt = (
            f"Open {target_url}. Using the already-created Uber account in this browser profile, "
            "start booking an Uber ride. Confirm the page is signed in with the same agent minted "
            f"identity from the first task. {booking_auth_instruction}"
            "Set the pickup to 88 Howard Street, San Francisco, CA 94105 and the destination to "
            "FITNESS SF Transbay, 425 Mission Street, San Francisco, CA 94105. Confirm both map pins "
            "are at those exact addresses and select UberX, not a premium or shared tier. Continue until the "
            "final action would submit, request, confirm, or pay for the ride; "
            "click that final button so the browser write-lock approval request stops you. Do not bypass "
            "or answer approval."
        )
        booking_task = replace(
            task,
            name=f"{task.name}-booking",
            title="Minted Agent Account Sticky Booking",
            prompt=booking_prompt,
            approval_handling="ignore",
            expected_attention_kind="write_lock",
            expected_attention_kinds=[],
            timeout_seconds=max(task.timeout_seconds, 900),
        )
        previous_write_lock = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "true"
        try:
            booking_result = await run_single_task(
                base_url,
                booking_task,
                keep_failed_agents=keep_failed_agents,
                on_agent_created=remember_owned_root,
            )
        finally:
            if previous_write_lock is None:
                del os.environ["BENCHMARK_WRITE_LOCK_ENABLED"]
            else:
                os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = previous_write_lock

        signup_proven = signup_result.passed or signup_account_evidence
        passed = signup_proven and minted is not None and booking_result.passed
        failure_parts = []
        if not signup_proven:
            failure_parts.append(f"signup failed: {signup_result.failure_reason or signup_result.status}")
        if minted is None:
            failure_parts.append(f"no MintedAccount row for {target_realm}")
        if not booking_result.passed:
            failure_parts.append(f"booking failed: {booking_result.failure_reason or booking_result.status}")

        benchmark_status = _aggregate_benchmark_status(passed, signup_result, booking_result)
        passed = benchmark_status == "PASSED"
        return TaskResult(
            name=task.name,
            passed=passed,
            agent_id=_with_gate_agent_ids(signup_result.agent_id, booking_result.agent_id),
            status="COMPLETED" if passed else "FAILED",
            benchmark_status=benchmark_status,
            progress_score=_with_gate_progress(signup_result.progress_score, booking_result.progress_score),
            duration_seconds=round(time.time() - start, 1),
            cost_cents=_with_gate_cost(signup_result.cost_cents, booking_result.cost_cents),
            message_count=_with_gate_message_count(signup_result.message_count, booking_result.message_count),
            failure_reason=" | ".join(failure_parts) if failure_parts else None,
            approvals_triggered=booking_result.approvals_triggered,
            approvals_resolved=booking_result.approvals_resolved,
            cache_read_input_tokens=_with_gate_cache_read(
                signup_result.cache_read_input_tokens,
                booking_result.cache_read_input_tokens,
            ),
            cache_creation_input_tokens=_with_gate_cache_creation(
                signup_result.cache_creation_input_tokens,
                booking_result.cache_creation_input_tokens,
            ),
            cache_hit_pct=0.0,
            fast_mode_cache_enabled=_with_gate_fast_mode(signup_result, booking_result),
            context_violations=_with_gate_context_violations(
                signup_result.context_violations,
                booking_result.context_violations,
            ),
            logs=_with_gate_logs({"signup": signup_result.logs, "booking": booking_result.logs}),
        )
    finally:
        print("    🧹 Preserved AgentIdentity primitive inbox and AgentPhone number")


_JUDGE_RESEARCH_TOOLS = {"web_search", "web_fetch", "grep"}


def _message_text_for_judge(message: dict) -> str:
    text_value = message.get("text", message.get("message", message.get("content", "")))
    if not isinstance(text_value, str):
        text_value = json.dumps(text_value, default=str)
    return text_value


def _compact_messages_for_judge(messages: list, *, limit: int = 80, text_chars: int = 400) -> list[dict]:
    """Keep tool/status chips, not 12k-char web_search bodies (smoke10 413'd at 35MB)."""
    compacted: list[dict] = []
    for message in messages[-limit:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").upper()
        if role in {"USER", "SYSTEM"}:
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        evidence_metadata = {
            key: metadata[key]
            for key in (
                "action_type",
                "toolName",
                "toolStatus",
                "agentType",
                "title",
                "url",
                "requestUserApproval",
                "toolCallId",
                "subAgentId",
                "task_id",
                "browser_url",
                "browser_session_metadata",
            )
            if key in metadata
        }
        compacted.append(
            {
                "role": role or "UNKNOWN",
                "text": _message_text_for_judge(message)[:text_chars],
                "metadata": evidence_metadata,
            }
        )
    return compacted


def _logical_explore_spawn_count(messages: list) -> int:
    """Count spawned explore children, not their repeated lifecycle/progress rows."""
    matching: list[tuple[int, str, str]] = []
    child_by_call_id: dict[str, str] = {}
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        if metadata.get("toolName") != "spawn_agent" or metadata.get("agentType") != "explore":
            continue
        call_id = str(metadata.get("toolCallId") or "").strip()
        child_id = str(
            metadata.get("subAgentId")
            or metadata.get("sub_agent_id")
            or metadata.get("taskId")
            or metadata.get("task_id")
            or ""
        ).strip()
        matching.append((index, call_id, child_id))
        if call_id and child_id:
            child_by_call_id[call_id] = child_id

    logical_ids: set[tuple[str, str]] = set()
    for index, call_id, child_id in matching:
        canonical_child = child_id or child_by_call_id.get(call_id, "")
        if canonical_child:
            logical_ids.add(("child", canonical_child))
        elif call_id:
            logical_ids.add(("tool", call_id))
        else:
            logical_ids.add(("row", str(index)))
    return len(logical_ids)


def _compact_tree_node_for_judge(agent_id: str, node: dict) -> dict:
    messages = node.get("messages") if isinstance(node.get("messages"), list) else []
    collected_count = len(messages)
    tool_counts: dict[str, int] = {}
    error_tool_count = 0
    research_tool_count = 0
    blob_parts = [str(node.get("goal") or ""), str(node.get("title") or "")]
    for message in messages:
        if not isinstance(message, dict):
            continue
        text_value = _message_text_for_judge(message)
        blob_parts.append(text_value[:400])
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        tool_name = str(metadata.get("toolName") or "")
        tool_status = str(metadata.get("toolStatus") or "").upper()
        if tool_name and tool_status == "FINISHED":
            tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
        if tool_name and tool_status == "ERROR":
            error_tool_count += 1
        if tool_name in _JUDGE_RESEARCH_TOOLS:
            research_tool_count += 1
    explore_spawn_count = _logical_explore_spawn_count(messages)
    blob = " ".join(blob_parts).lower()
    mentions_andy = "andy prevalsky" in blob or "andy's" in blob
    mentions_aman = "aman gottumukkala" in blob or "aman's" in blob
    goal = str(node.get("goal") or "")
    agent_type = "general_purpose" if goal.startswith("You are analyzing ONE creator") else node.get("agent_type")
    has_real_work = (
        collected_count >= 2 or research_tool_count >= 1 or explore_spawn_count >= 1 or sum(tool_counts.values()) >= 1
    )
    completion_cards = _completion_cards_from_messages(messages)
    completion_card = completion_cards[-1] if completion_cards else {}
    return {
        "agent_id": agent_id,
        "parent_agent_id": node.get("parent_agent_id"),
        "status": node.get("status"),
        "agent_type": agent_type,
        "goal": goal[:240],
        "title": str(node.get("title") or "")[:120],
        "message_count": collected_count if collected_count else int(node.get("message_count") or 0),
        "tool_counts": tool_counts,
        "error_tool_count": error_tool_count,
        "research_tool_count": research_tool_count,
        "explore_spawn_count": explore_spawn_count,
        "has_real_transcript": has_real_work,
        "has_traj_end_stub": is_ablated_completion_summary((completion_card or {}).get("summary"))
        and not has_real_work,
        "mentions_andy": mentions_andy,
        "mentions_aman": mentions_aman,
        "response_schema": node.get("response_schema") or node.get("output_schema"),
        "structured_output_present": bool(node.get("structured_output") or node.get("structured_response")),
        "completion_summary": str((completion_card or {}).get("summary") or "")[:240],
        "completion_outputs_count": len((completion_card or {}).get("outputs") or [])
        if isinstance((completion_card or {}).get("outputs"), list)
        else 0,
        "completion_is_ablated": is_ablated_completion_summary((completion_card or {}).get("summary")),
    }


def _child_tool_counts_from_root_messages(messages: list) -> dict[str, dict[str, int]]:
    """Parent spawn chips carry childToolCounts when Agent.messageCount is stale."""
    out: dict[str, dict[str, int]] = {}
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        sub_id = metadata.get("subAgentId") or metadata.get("sub_agent_id")
        counts = metadata.get("childToolCounts") or metadata.get("child_tool_counts")
        if not sub_id or not isinstance(counts, dict):
            continue
        normalized = {str(name): int(count or 0) for name, count in counts.items() if int(count or 0) > 0}
        if normalized:
            out[str(sub_id)] = normalized
    return out


def _is_explore_tree_node(node: dict) -> bool:
    if node.get("agent_type") == "explore":
        return True
    goal = str(node.get("goal") or "")
    title = str(node.get("title") or "")
    return goal.startswith("Explore ") or "explore agent" in title.lower()


def _tree_root_id(tree: dict, data: dict) -> Optional[str]:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    hinted = agent.get("agent_id") or agent.get("id")
    if hinted and str(hinted) in tree:
        return str(hinted)
    for agent_id, node in tree.items():
        if isinstance(node, dict) and not node.get("parent_agent_id"):
            return str(agent_id)
    return None


def _has_real_gp_transcript(node: dict) -> bool:
    if node.get("has_real_transcript"):
        return True
    if int(node.get("message_count") or 0) >= 2:
        return True
    if int(node.get("research_tool_count") or 0) >= 1:
        return True
    if int(node.get("explore_spawn_count") or 0) >= 1:
        return True
    tools = node.get("tool_counts") if isinstance(node.get("tool_counts"), dict) else {}
    return sum(int(count or 0) for count in tools.values()) >= 1


def _apply_parent_child_tool_counts(compact_tree: dict, data: dict) -> None:
    """Fill empty GP nodes from parent spawn childToolCounts (smoke13 stale count=1)."""
    raw_tree = (data.get("_benchmark") or {}).get("tree") if isinstance(data.get("_benchmark"), dict) else {}
    raw_tree = raw_tree if isinstance(raw_tree, dict) else {}
    logs_tree = (data.get("logs") or {}).get("tree") if isinstance(data.get("logs"), dict) else {}
    logs_tree = logs_tree if isinstance(logs_tree, dict) else {}
    root_id = _tree_root_id(compact_tree, data)
    root_messages: list = []
    if root_id:
        for source in (raw_tree.get(root_id), logs_tree.get(root_id)):
            if isinstance(source, dict) and isinstance(source.get("messages"), list):
                root_messages = source["messages"]
                break
    if not root_messages:
        root_messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    child_tools = _child_tool_counts_from_root_messages(root_messages)
    for agent_id, node in compact_tree.items():
        counts = child_tools.get(str(agent_id))
        if not counts or _has_real_gp_transcript(node):
            continue
        merged = {**counts, **(node.get("tool_counts") or {})}
        node["tool_counts"] = merged
        node["research_tool_count"] = int(node.get("research_tool_count") or 0) + sum(
            int(counts.get(name) or 0) for name in _JUDGE_RESEARCH_TOOLS
        )
        node["explore_spawn_count"] = int(node.get("explore_spawn_count") or 0) + int(counts.get("spawn_agent") or 0)
        node["has_real_transcript"] = True
        if int(node.get("message_count") or 0) < 2:
            node["message_count"] = max(int(node.get("message_count") or 0), sum(counts.values()))


def _first_level_gps_from_compact_tree(compact_tree: dict, data: dict) -> list[dict]:
    root_id = _tree_root_id(compact_tree, data)
    if not root_id:
        return []
    gps: list[dict] = []
    for agent_id, node in compact_tree.items():
        if str(node.get("parent_agent_id") or "") != str(root_id):
            continue
        if _is_explore_tree_node(node):
            continue
        gps.append(
            {
                "agent_id": agent_id,
                "status": node.get("status"),
                "agent_type": node.get("agent_type"),
                "goal": str(node.get("goal") or "")[:240],
                "mentions_andy": bool(node.get("mentions_andy")),
                "mentions_aman": bool(node.get("mentions_aman")),
                "message_count": int(node.get("message_count") or 0),
                "research_tool_count": int(node.get("research_tool_count") or 0),
                "explore_spawn_count": int(node.get("explore_spawn_count") or 0),
                "has_real_transcript": _has_real_gp_transcript(node),
                "has_traj_end_stub": bool(node.get("has_traj_end_stub")),
                "completion_summary": str(node.get("completion_summary") or "")[:240],
                "completion_outputs_count": int(node.get("completion_outputs_count") or 0),
                "completion_is_ablated": bool(node.get("completion_is_ablated")),
            }
        )
    return gps


def _raw_benchmark_tree(data: dict) -> dict:
    """The full per-agent tree (with structured_output), wherever this run record keeps it."""
    for holder in (data.get("_benchmark"), data.get("logs")):
        tree = holder.get("tree") if isinstance(holder, dict) else None
        if isinstance(tree, dict) and tree:
            return tree
    return {}


def _completion_structured_output_schema_check(data: dict, check: dict) -> tuple[bool, str]:
    """The root and every first-level GP finished with output that satisfies its response_schema.

    Uses the verifier's own completion contract (``_build_verifier_response_model``),
    so a value is valid here exactly when the verifier would accept it as complete.
    """
    from helpers.llm import _build_verifier_response_model

    tree = _raw_benchmark_tree(data)
    root_id = _tree_root_id(tree, data)
    if not root_id:
        return False, "T7: no root agent in the benchmark tree"
    agent_ids = [root_id]
    if check.get("include_first_level_gps", True):
        agent_ids += [
            agent_id
            for agent_id, node in tree.items()
            if isinstance(node, dict)
            and str(node.get("parent_agent_id") or "") == str(root_id)
            and not _is_explore_tree_node(node)
        ]
    failures: list[str] = []
    for agent_id in agent_ids:
        node = tree.get(agent_id) or {}
        schema = node.get("response_schema") or node.get("output_schema")
        if not isinstance(schema, dict) or not schema.get("fields"):
            continue
        output_model = _build_verifier_response_model(schema).model_fields["output"].annotation
        try:
            output_model.model_validate(node.get("structured_output") or node.get("structured_response") or {})
        except Exception as error:
            problems = getattr(error, "errors", lambda: [])()
            detail = ", ".join(f"{'.'.join(str(p) for p in item['loc'])}:{item['type']}" for item in problems[:4])
            failures.append(f"{str(agent_id)[:8]} ({len(problems)} invalid: {detail})")
    if failures:
        return (
            False,
            f"T7: {len(failures)} of {len(agent_ids)} completion outputs do not satisfy their response_schema: "
            + "; ".join(failures[:5]),
        )
    return True, ""


def _first_level_gps_from_data(data: dict) -> list[dict]:
    return list(_compact_benchmark_state_for_judge(data).get("first_level_gps") or [])


def _nested_general_purpose_violations(compact_tree: dict) -> list[dict]:
    """GPs whose parent is itself GP / for_each / explore — typed evidence for T6."""
    by_id = {str(agent_id): node for agent_id, node in compact_tree.items() if isinstance(node, dict)}
    violations: list[dict] = []
    for agent_id, node in by_id.items():
        agent_type = str(node.get("agent_type") or "")
        goal = str(node.get("goal") or "")
        is_gp = agent_type == "general_purpose" or goal.startswith("You are analyzing ONE creator")
        if not is_gp:
            continue
        parent_id = str(node.get("parent_agent_id") or "")
        if not parent_id or parent_id not in by_id:
            continue
        parent = by_id[parent_id]
        parent_type = str(parent.get("agent_type") or "")
        parent_goal = str(parent.get("goal") or "")
        parent_is_gp = parent_type in {"general_purpose", "for_each"} or parent_goal.startswith(
            "You are analyzing ONE creator"
        )
        parent_is_explore = _is_explore_tree_node(parent)
        if parent_is_gp or parent_is_explore:
            violations.append(
                {
                    "agent_id": agent_id,
                    "parent_agent_id": parent_id,
                    "parent_agent_type": parent_type or ("explore" if parent_is_explore else "general_purpose"),
                }
            )
    return violations


def _text_mentions_andy(text: str) -> bool:
    blob = str(text or "").lower()
    return "andy prevalsky" in blob or "andy's" in blob or "for andy" in blob


def _text_presents_aman_as_user(text: str) -> bool:
    """True when Aman is framed as the principal user/owner (not schema key leftovers)."""
    blob = str(text or "").lower()
    if "aman gottumukkala" not in blob and "aman's" not in blob:
        return False
    # Historical July schema keys / phrase leftovers are not Aman-as-principal.
    if "opportunities_for_aman" in blob or "opportunities for aman" in blob:
        cleaned = blob.replace("opportunities_for_aman", " ").replace("opportunities for aman", " ")
        if "aman gottumukkala" not in cleaned and "aman's" not in cleaned:
            return False
        blob = cleaned
    andy_present = _text_mentions_andy(blob)
    aman_owner_markers = (
        "for aman gottumukkala",
        "aman gottumukkala is",
        "aman's personal brand",
        "building a personal brand for aman",
        "principal user",
    )
    if any(marker in blob for marker in aman_owner_markers):
        return True
    # Aman named without Andy in the same root/completion blob → treat as principal.
    return not andy_present


def _principal_user_andy_check(data: dict) -> tuple[bool, str]:
    """T1: Andy is principal; Aman is not the user/owner on root goal or completion."""
    compact = _compact_benchmark_state_for_judge(data)
    tree = compact.get("tree") if isinstance(compact.get("tree"), dict) else {}
    root_id = _tree_root_id(tree, data)
    root = tree.get(str(root_id)) if root_id else None
    root = root if isinstance(root, dict) else {}
    root_goal = str(root.get("goal") or "")
    completion_summary = str(root.get("completion_summary") or "")
    if not completion_summary:
        completion_summary = _root_deliverable_blob(data)[:240]
    first_level = compact.get("first_level_gps") if isinstance(compact.get("first_level_gps"), list) else []
    gps_mention_andy = any(
        _text_mentions_andy(str(gp.get("goal") or "")) or bool(gp.get("mentions_andy"))
        for gp in first_level
        if isinstance(gp, dict)
    )
    andy_ok = (
        bool(root.get("mentions_andy"))
        or _text_mentions_andy(root_goal)
        or _text_mentions_andy(completion_summary)
        or gps_mention_andy
    )
    if _text_presents_aman_as_user(root_goal) or _text_presents_aman_as_user(completion_summary):
        return False, "T1: root goal or completion presents Aman as the principal user"
    if not andy_ok:
        return False, "T1: no Andy Prevalsky principal evidence on root/first-level GPs/completion"
    return True, "All declared static checks passed"


def _judge_source_trees(data: dict) -> list[dict]:
    """Return every raw tree source; validators may need evidence from either one."""
    raw = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    trees: list[dict] = []
    for candidate in (
        raw.get("tree"),
        (data.get("logs") or {}).get("tree") if isinstance(data.get("logs"), dict) else None,
    ):
        if isinstance(candidate, dict) and candidate:
            trees.append(candidate)
    return trees


def _judge_source_tree(data: dict) -> dict:
    """Prefer collected transcripts; fall back to logs.tree when `_benchmark.tree` is metadata-only."""
    trees = _judge_source_trees(data)
    if not trees:
        return {}
    if len(trees) == 1:
        return trees[0]
    merged: dict[str, dict] = {}
    for tree in trees:
        for agent_id, node in tree.items():
            if not isinstance(node, dict):
                continue
            key = str(agent_id)
            existing = merged.get(key)
            if existing is None:
                merged[key] = node
                continue
            existing_msgs = existing.get("messages") if isinstance(existing.get("messages"), list) else []
            node_msgs = node.get("messages") if isinstance(node.get("messages"), list) else []
            if len(node_msgs) > len(existing_msgs):
                merged[key] = node
    return merged


def _compact_benchmark_state_for_judge(data: dict) -> dict:
    """Typed tree/usage only — full child transcripts 413 the judge (smoke10)."""
    raw = data.get("_benchmark") if isinstance(data.get("_benchmark"), dict) else {}
    compact = {key: value for key, value in raw.items() if key not in {"tree", "all_agents", "first_level_gps"}}
    tree = _judge_source_tree(data)
    compact_tree: dict[str, dict] = {}
    if tree:
        compact_tree = {
            str(agent_id): _compact_tree_node_for_judge(str(agent_id), node)
            for agent_id, node in tree.items()
            if isinstance(node, dict)
        }
        _apply_parent_child_tool_counts(compact_tree, data)
        compact["tree"] = compact_tree
    collected_counts = {agent_id: int(node.get("message_count") or 0) for agent_id, node in compact_tree.items()}
    agents = raw.get("all_agents")
    if isinstance(agents, list):
        compact["all_agents"] = [
            {
                "agent_id": agent.get("agent_id") or agent.get("id"),
                "parent_agent_id": agent.get("parent_agent_id"),
                "status": agent.get("status"),
                "goal": str(agent.get("goal") or "")[:240],
                "message_count": collected_counts.get(str(agent.get("agent_id") or agent.get("id") or ""))
                or agent.get("message_count")
                or 0,
                "depth": agent.get("depth"),
            }
            for agent in agents
            if isinstance(agent, dict)
        ]
    compact["first_level_gps"] = _first_level_gps_from_compact_tree(compact_tree, data)
    nested_violations = _nested_general_purpose_violations(compact_tree)
    # Typed T6 evidence so the LLM judge cannot fail closed on "tree truncated"
    # when parentage is fully available in compact form (mass-agent Fast Mode).
    compact["nested_general_purpose_count"] = len(nested_violations)
    compact["nested_general_purpose_violations"] = nested_violations[:20]
    root_id = _tree_root_id(compact_tree, data)
    root_node = compact_tree.get(str(root_id)) if root_id else None
    root_node = root_node if isinstance(root_node, dict) else {}
    compact["principal_user"] = {
        "mentions_andy": bool(root_node.get("mentions_andy")),
        "mentions_aman": bool(root_node.get("mentions_aman")),
        "completion_summary": str(root_node.get("completion_summary") or "")[:240],
    }
    compact["usage"] = {
        "cost_cents": data.get("cost_cents") or raw.get("cost_cents") or 0,
        "tokens_out": data.get("tokens_out") or raw.get("tree_tokens_out") or 0,
        "cache_creation_input_tokens": data.get("cache_creation_input_tokens")
        or raw.get("cache_creation_input_tokens")
        or 0,
        "live_output_tokens": data.get("live_output_tokens") or raw.get("live_output_tokens") or 0,
        "cache_read_input_tokens": data.get("cache_read_input_tokens") or raw.get("cache_read_input_tokens") or 0,
    }
    return compact


def _apply_compact_benchmark_state(evidence: list[dict], compact_state: dict) -> list[dict]:
    for row in evidence:
        if isinstance(row, dict) and "benchmark_state" in row:
            row["benchmark_state"] = compact_state
            break
    else:
        evidence.append({"benchmark_state": compact_state})
    return evidence


def _append_structured_output_evidence(evidence: list[dict], data: dict) -> list[dict]:
    """Prefer the agent's populated response-schema output for declared judges.

    Completion-card prose can be huge and previously got head+tail truncated by
    the verifier TOOL_RESULT budget, hiding middle ranks. ``structured_output``
    is the compact schema payload (e.g. 100 repos) and should always be visible.
    """
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    structured = agent.get("structured_output")
    if structured is None:
        structured = agent.get("structuredOutput")
    if structured is None:
        return evidence
    row = {
        "role": "ASSISTANT",
        "text": json.dumps({"structured_output": structured}, default=str),
        "metadata": {"evidence_type": "structured_output"},
    }
    # Put structured output first so budget-sensitive judges see it even if a
    # later layer ever reintroduces truncation.
    return [row, *evidence]


def _declared_evaluator_evidence(data: dict) -> list[dict]:
    """Build the evidence-only context for a declared LLM judge.

    Root and sub-agent transcripts come whole from the tree-aware single-turn
    builder, with each tool result bounded by the runtime per-result cap.
    ``benchmark_state`` is the compact T-row view so mass-agent trees do not
    carry 35MB child bodies twice. There is no grader-only budget: a prompt
    that would overflow the judge model is sent to the agentic judge instead
    (``_call_declared_llm_judge``).
    """
    from benchmarks.semantic_evaluator_evidence import build_single_turn_evidence

    compact_state = _compact_benchmark_state_for_judge(data)
    evidence = _apply_compact_benchmark_state(build_single_turn_evidence(data), compact_state)
    return _append_structured_output_evidence(evidence, data)


_DECLARED_JUDGE_USER_TEXT = "Evaluate the supplied run evidence against the benchmark requirements."


async def _declared_judge_context_overflows(verifier_prompt: str, evidence_text: str) -> bool:
    """True when the single-turn judge prompt would overflow its model.

    Same window, estimator and trigger the agent loop uses before every LLM
    call (``run_agent.compaction_trigger_tokens``). The evidence is measured
    as ``check_progress`` re-serializes it into its TOOL_RESULT line.
    """
    from helpers.llm import VERIFIER_MODEL
    from helpers.model_info import get_model_context_window
    from helpers.summarize import estimate_context_tokens
    from loop.run_agent import compaction_trigger_tokens

    context = [
        {"role": "SYSTEM", "text": verifier_prompt},
        {"role": "USER", "text": _DECLARED_JUDGE_USER_TEXT},
        {"role": "TOOL", "text": "TOOL_RESULT " + json.dumps(evidence_text, ensure_ascii=False)},
    ]
    window = await get_model_context_window(VERIFIER_MODEL)
    return estimate_context_tokens(context) >= compaction_trigger_tokens(window)


_AGENTIC_JUDGE_OUTPUT_SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "score",
            "type": "float",
            "description": (
                "1.0 only when every catalog criterion is directly grounded in the attached "
                "trajectory evidence; otherwise 0.0."
            ),
        },
        {
            "name": "reasoning",
            "type": "str",
            "description": (
                "Concise pass/fail explanation citing the grounded evidence locations "
                "(tool messages, payment approval metadata, browser actions)."
            ),
        },
    ]
}


def _declared_agentic_evaluator_evidence(data: dict) -> dict[str, Any]:
    """Build a full trajectory bundle for an agentic Codex judge.

    ``benchmark_state`` is the same compact typed view the single-turn judge
    gets (``completion_outputs_count`` etc. per first-level GP), which T7's
    judge prompt tells it to use; the raw state would carry every child body
    a second time and none of those typed fields.
    """
    from benchmarks.semantic_evaluator_evidence import build_agentic_evidence

    evidence = build_agentic_evidence(data)
    evidence["benchmark_state"] = _compact_benchmark_state_for_judge(data)
    return evidence


async def _hydrate_semantic_evaluator_tree(data: dict, base_url: str) -> None:
    """Attach full agent-tree transcripts for semantic evaluators (best-effort)."""
    if data.get("_semantic_evaluator_tree") is not None:
        return
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
    if not root_id or not base_url:
        data["_semantic_evaluator_tree"] = None
        return
    try:
        tree_agents = await get_agent_tree(base_url, root_id)
        if len(tree_agents) <= 1:
            data["_semantic_evaluator_tree"] = None
            return
        data["_semantic_evaluator_tree"] = await collect_tree_messages(
            root_id,
            tree_agents,
            lambda agent_id: get_agent(base_url, agent_id),
        )
    except Exception as exc:
        data["_semantic_evaluator_tree"] = None
        data.setdefault("_benchmark", {})["_semantic_evaluator_tree_error"] = str(exc)[:300]


DISPLAY_TRANSCRIBE_MODEL = "rose-labs/rose-1-ultra"


async def _hydrate_display_artifacts(data: dict, base_url: str) -> None:
    """Attach the Agent Display items shown anywhere in this agent tree (benchmarks/display_check.py)."""
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()

    async def tree_messages() -> list[dict]:
        rows: list[dict] = []
        for member in await get_agent_tree(base_url, root_id) if root_id else []:
            member_id = str(member.get("id") or member.get("agent_id") or "")
            if not member_id or member_id == root_id:
                continue
            detail = await get_agent(base_url, member_id)
            rows.extend(dict(m, _agent_id=member_id) for m in detail.get("messages") or [] if isinstance(m, dict))
        return rows

    async def fetch_usercontent(path: str) -> Optional[bytes]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{base_url.rstrip('/')}{path}")
        if response.status_code != 200:
            raise RuntimeError(f"GET {path[:120]} returned HTTP {response.status_code}")
        return response.content

    async def fetch_storage(storage_path: str) -> Optional[bytes]:
        from helpers.attachments import download_from_storage

        return await download_from_storage(storage_path)

    async def transcribe_image(raw: bytes, mime: str) -> str:
        from helpers.llm import call_llm

        result = await call_llm(
            messages=display_check.transcription_messages(raw, mime),
            model=DISPLAY_TRANSCRIBE_MODEL,
            temperature=0.0,
            max_tokens=1200,
            call_site="benchmark_display_transcribe",
        )
        content = result.get("content") if isinstance(result, dict) else None
        return content if isinstance(content, str) else str(content or "")

    await display_check.hydrate_display_artifacts(
        data,
        tree_messages=tree_messages,
        fetch_usercontent=fetch_usercontent,
        fetch_storage=fetch_storage,
        transcribe_image=transcribe_image,
    )


def _build_agentic_judge_goal(task: BenchmarkTask, evaluator: dict) -> str:
    criteria = "\n".join(f"- {criterion}" for criterion in evaluator.get("criteria", []))
    return f"""You are a strict benchmark judge for a live agent trajectory.

Read the attached `benchmark_evidence.json` file in /home/user/attachments/. Search it thoroughly
with shell tools (grep, jq, less) before scoring. The task prompt and criteria below describe
requirements; they are not evidence.

Score exactly 1.0 only when every criterion is directly grounded in tool/browser output,
payment-request metadata, or typed benchmark state inside the evidence file. Otherwise score 0.0
and explain the first missing or contradicted requirement. The pending payment approval itself
is valid grounding for item, total, store, and pickup facts when those fields appear there.
Unsupported assistant claims without tool evidence are not proof.

Task requirement: {task.prompt}
Criteria:
{criteria}
Judge-specific instruction: {evaluator.get("judge_prompt", "")}

Write the final verdict to `/home/user/output/judgment.json` as JSON with `score` (1.0 or 0.0)
and `reasoning` fields, then validate that file exists before finishing.
"""


async def _fetch_agentic_judge_compute_token(user_id: str, agent_id: str) -> dict[str, Any] | None:
    """A synced GPT/Codex subscription token for the benchmark judge harness, or None.

    None is not a failure: the judge then spawns Codex without a token and the
    backend's own resolver chooses, subscriptions first and then the funded Azure
    fallback (resolveCodexSpawnAuth), so an exhausted pool no longer breaks judging.
    """
    from config import load_config
    from helpers.llm import fetch_gpt_code_token_activity

    token_data = await fetch_gpt_code_token_activity(user_id)
    if token_data and token_data.get("accessToken"):
        return {**token_data, "type": "gpt"}

    config = load_config()
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{config.backend.api_url}/api/integrations/compute-code/credentials/token",
            headers={
                "X-API-Key": config.backend.api_key or "",
                "X-User-Id": user_id,
            },
            params={"tokenType": "gpt", "agentId": agent_id},
            timeout=15.0,
        )
        if response.status_code == 200:
            data = response.json()
            if data.get("accessToken") and data.get("type") == "gpt":
                return {
                    "type": "gpt",
                    "accessToken": data["accessToken"],
                    "accountId": data.get("accountId"),
                    "source": data.get("source", "user"),
                    "poolTokenId": data.get("poolTokenId"),
                }

    return None


async def _parse_agentic_judge_verdict(result: dict) -> tuple[float, str]:
    """Read the benchmark judge score from Codex output, not harness verifier progress."""
    structured = result.get("structured_response") if isinstance(result.get("structured_response"), dict) else {}
    if "score" in structured:
        try:
            score = float(structured["score"])
            reasoning = str(structured.get("reasoning") or "")
            if reasoning:
                return score, reasoning
        except (TypeError, ValueError):
            pass

    from helpers.attachments import FilePointer, get_file_content

    for file_pointer in result.get("output_files") or []:
        if not isinstance(file_pointer, dict):
            continue
        if str(file_pointer.get("original_filename") or "") != "judgment.json":
            continue
        try:
            content = await get_file_content(FilePointer.from_dict(file_pointer))
            parsed = json.loads(content.decode("utf-8"))
            score = float(parsed.get("score", 0.0))
            reasoning = str(parsed.get("reasoning") or "")
            if reasoning:
                return score, reasoning
        except (TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
            continue

    message = str(result.get("message") or "")
    for line in message.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{") or "score" not in stripped:
            continue
        try:
            parsed = json.loads(stripped)
            score = float(parsed.get("score", 0.0))
            reasoning = str(parsed.get("reasoning") or "")
            if reasoning:
                return score, reasoning
        except (TypeError, ValueError, json.JSONDecodeError):
            continue

    return 0.0, "Agentic judge returned no parseable benchmark verdict"


async def _call_declared_agentic_llm_judge(
    task: BenchmarkTask,
    evaluator: dict,
    data: dict,
) -> dict:
    """Execute one catalog-declared agentic judge via the Codex code harness."""
    from domains.spawn_claude_code_agent.service import spawn_claude_code_activity
    from helpers.attachments import upload_to_storage

    _sync_compute_tokens(required_token_types=("gpt",))

    user_id = _current_benchmark_user_id()
    judge_agent_id = str(uuid.uuid4())
    tool_call_id = str(uuid.uuid4())
    token_data = await _fetch_agentic_judge_compute_token(user_id, judge_agent_id) or {}

    if getattr(task, "process_spec", None) is not None:
        from benchmarks.process_bench import process_evidence

        evidence = {"process_spec": task.process_spec, "full_trajectory": process_evidence(data)}
    else:
        evidence = _declared_agentic_evaluator_evidence(data)
    evidence_bytes = json.dumps(evidence, default=str, indent=2).encode("utf-8")
    attachment = await upload_to_storage(
        user_id,
        evidence_bytes,
        "benchmark_evidence.json",
        "application/json",
    )

    result = await spawn_claude_code_activity(
        user_id=user_id,
        agent_id=judge_agent_id,
        goal=_build_agentic_judge_goal(task, evaluator),
        tool_call_id=tool_call_id,
        output_schema=_AGENTIC_JUDGE_OUTPUT_SCHEMA,
        attachments=[attachment],
        code_provider="codex",
        gpt_token=token_data.get("accessToken"),
        gpt_account_id=token_data.get("accountId"),
        gpt_token_source=token_data.get("source"),
        gpt_token_pool_id=token_data.get("poolTokenId"),
        fast_mode_cache_enabled=False,
    )
    # Only when every funded path (subscriptions and the Azure fallback) is exhausted
    # does judging stop; that stays a compute-token SKIP, never a task FAIL.
    if result.get("failure_kind") == "no_credentials" or result.get("usage_limit"):
        raise ComputeTokenUnavailable(
            "No Codex subscription or funded Azure credential available for agentic benchmark judge"
        )

    score, reasoning = await _parse_agentic_judge_verdict(result)
    usage_items = result.get("usage_items") if isinstance(result.get("usage_items"), list) else []
    usage = aggregate_usage_items(usage_items) if usage_items else None
    return {
        "score": score,
        "reasoning": reasoning,
        "usage": usage,
        "judge_audit": _agentic_judge_audit(judge_agent_id, attachment, evidence_bytes),
    }


def _agentic_judge_audit(judge_agent_id: str, attachment: Any, evidence_bytes: bytes) -> dict[str, Any]:
    """What a verdict was based on: the exact evidence file and the judge session that read it."""
    pointer = attachment if isinstance(attachment, dict) else {}
    return {
        "judge_agent_id": judge_agent_id,
        "evidence_sha256": hashlib.sha256(evidence_bytes).hexdigest(),
        "evidence_bytes": len(evidence_bytes),
        "evidence_file_id": pointer.get("id"),
        "evidence_storage_path": pointer.get("storage_path"),
    }


async def _benchmark_judge_claude_auth_kwargs(user_id: str | None = None) -> dict:
    """Fetch Claude OAuth for harness-side judges (declared evaluators / semantic judges).

    Agent workflows already resolve Claude auth via Temporal activities. Harness-side
    ``check_progress`` calls (post-run judges) previously omitted the token, so Rose
    fell through OpenAI → Anthropic API key → OpenRouter and failed with 402 when
    those funded paths were empty — even though the same user's Claude OAuth worked
    for the agent itself. Pass the OAuth token so judges share the agent auth path.
    """
    from helpers.llm import fetch_claude_max_token

    resolved_user_id = (user_id or "").strip() or _current_benchmark_user_id()
    if not resolved_user_id:
        return {}
    try:
        token_data = await fetch_claude_max_token(resolved_user_id)
    except Exception as exc:  # judge still runs; auth is best-effort
        print(f"    ⚠ Declared-judge Claude auth fetch failed: {exc}")
        return {}
    if not token_data or not token_data.get("accessToken"):
        return {}
    return {
        "claude_token": token_data["accessToken"],
        "claude_token_source": token_data.get("source"),
        "claude_token_pool_id": token_data.get("poolTokenId"),
        "claude_token_user_id": resolved_user_id,
    }


async def _benchmark_judge_gpt_auth_kwargs(user_id: str | None = None) -> dict:
    """Fetch GPT/Codex OAuth for harness-side declared judges.

    Same failure mode as Claude: post-run ``check_progress`` previously omitted
    GPT OAuth, so Rose used the org OpenAI API key (often credit-exhausted) then
    OpenRouter waterfall. Reasoning models there hit the declared-evaluator
    max_tokens ceiling with reasoning-only streams and failed the judge even when
    the agent completed successfully. Pass the user's GPT token so the judge
    shares the agent auth path (direct_auth:gpt).
    """
    from helpers.llm import fetch_gpt_code_token_activity

    resolved_user_id = (user_id or "").strip() or _current_benchmark_user_id()
    if not resolved_user_id:
        return {}
    try:
        token_data = await fetch_gpt_code_token_activity(resolved_user_id)
    except Exception as exc:  # judge still runs; auth is best-effort
        print(f"    ⚠ Declared-judge GPT auth fetch failed: {exc}")
        return {}
    if not token_data or not token_data.get("accessToken"):
        return {}
    return {
        "gpt_token": token_data["accessToken"],
        "gpt_account_id": token_data.get("accountId"),
        "gpt_token_source": token_data.get("source"),
        "gpt_token_pool_id": token_data.get("poolTokenId"),
        "gpt_token_user_id": resolved_user_id,
    }


class BenchmarkJudgeUnavailable(RuntimeError):
    """A harness-side LLM judge produced no verdict, so the run was never evaluated."""


# check_progress already retries six times inside one VERIFIER_TOTAL_TIMEOUT_S
# fence, but its in-call backoff totals only ~6s, so a provider 429 burst
# exhausts it within ~25s. Re-invoking after 30s and then 60s keeps the judge
# retrying across ~165s of rate limiting, close to Claude Code's withRetry window.
BENCHMARK_JUDGE_NO_VERDICT_RETRY_DELAYS_S = (30.0, 60.0)


def _judge_no_verdict_summary(judged: dict) -> str:
    summary = str(judged.get("reasoning") or "judge returned no verdict")
    judge_error = judged.get("judge_error")
    provider = judge_error.get("provider") if isinstance(judge_error, dict) else None
    if isinstance(provider, dict):
        statuses = sorted({str(step.get("status")) for step in provider.get("steps") or []})
        detail = f"{provider.get('type')}: {provider.get('message')}"
        if statuses:
            detail += f"; step statuses {', '.join(statuses)}"
        summary += f" [{detail}]"
    return summary


async def _judge_until_verdict(
    call_judge: Callable[[], Awaitable[dict]],
    *,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict:
    """Invoke an idempotent harness judge until check_progress yields a verdict.

    Raises BenchmarkJudgeUnavailable when every bounded re-invocation ends
    without one; callers surface that as a harness ERROR, never a FAIL.
    """
    from helpers.llm import VERIFIER_TOTAL_TIMEOUT_S

    # A re-invocation starts only while a whole verifier deadline still fits, so
    # one judge spends at most two verifier deadlines even if every call stalls.
    budget_s = 2 * VERIFIER_TOTAL_TIMEOUT_S
    started = monotonic()
    delays = iter(BENCHMARK_JUDGE_NO_VERDICT_RETRY_DELAYS_S)
    attempts = 0
    while True:
        judged = await call_judge()
        attempts += 1
        if judged.get("verdict_available") is not False:
            return judged
        summary = _judge_no_verdict_summary(judged)
        delay_s = next(delays, None)
        if delay_s is None or monotonic() - started + delay_s + VERIFIER_TOTAL_TIMEOUT_S > budget_s:
            raise BenchmarkJudgeUnavailable(
                f"LLM judge produced no verdict after {attempts} judge attempt(s) (judge unavailable): {summary}"
            )
        print(f"    ⚠ LLM judge produced no verdict ({summary}); re-judging in {delay_s:.0f}s")
        await asyncio.sleep(delay_s)


async def _call_declared_llm_judge(
    task: BenchmarkTask,
    evaluator: dict,
    data: dict,
    evidence: list[dict] | None = None,
) -> dict:
    """Execute one catalog-declared single-turn judge against grounded run evidence."""
    from helpers.llm import check_progress

    criteria = "\n".join(f"- {criterion}" for criterion in evaluator.get("criteria", []))
    task_requirement = (
        _doordash_food_plan_task_requirement_for_judge(task)
        if task.name == DOORDASH_FOOD_PLAN_TASK_NAME
        else task.prompt
    )
    manifest_context = _doordash_food_plan_manifest_context_for_judge(task)
    manifest_block = (
        f"\n\nCanonical manifest checklist (ground truth for item matching):\n{manifest_context}"
        if manifest_context
        else ""
    )
    verifier_prompt = f"""You are a strict benchmark judge for a live ecommerce transaction.

The task prompt and criteria below describe requirements; they are not evidence. Score exactly 1.0 only
when every criterion is directly grounded in tool/browser output, typed benchmark state, or fields that
appear on a pending payment-approval / request_payment_card attention request (merchant, line items,
date/time, seat, fees, totals, product URLs, ratings). Otherwise score 0.0 and explain the first missing
or contradicted requirement. Generic non-payment attention requests (auth assistance, write-lock without
a receipt, login blockers) prove only their typed terminal gate — not cart contents. Unsupported
assistant claims are not proof. Authentication assistance, login blockers, missing inventory, and
unavailable eligible orders fail unless a criterion explicitly defines that state as success.

Task requirement: {task_requirement}{manifest_block}
Criteria:
{criteria}
Judge-specific instruction: {evaluator.get("judge_prompt", "")}
"""
    if evidence is None:
        evidence = _declared_evaluator_evidence(data)
    if task.name == DOORDASH_FOOD_PLAN_TASK_NAME:
        cart_evidence = _doordash_food_plan_supplemental_cart_evidence(data)
        if cart_evidence:
            evidence.append(
                {
                    "role": "TOOL",
                    "text": cart_evidence,
                    "metadata": {"evidence_type": "doordash_food_plan_cart_itemization"},
                }
            )
    evidence_text = json.dumps(evidence, default=str)
    if await _declared_judge_context_overflows(verifier_prompt, evidence_text):
        # Context overflow: the agentic judge reads the whole trajectory from
        # a file instead of a truncated single-turn prompt.
        judged = await _call_declared_agentic_llm_judge(task, evaluator, data)
        return {**judged, "evidence_mode": "agentic_llm_judge"}
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    judge_user_id = agent.get("userId") or agent.get("user_id") or _current_benchmark_user_id()
    claude_auth = await _benchmark_judge_claude_auth_kwargs(judge_user_id)
    gpt_auth = await _benchmark_judge_gpt_auth_kwargs(judge_user_id)

    async def judge() -> dict:
        return await check_progress(
            context=[
                {
                    "role": "USER",
                    "text": _DECLARED_JUDGE_USER_TEXT,
                },
                {
                    "role": "TOOL",
                    "text": evidence_text,
                    "metadata": {"benchmark_final_evidence": True},
                },
            ],
            verifier_system_prompt=verifier_prompt,
            response_schema=None,
            call_site="benchmark_declared_evaluator",
            agent_id=agent.get("agent_id") or agent.get("id"),
            **claude_auth,
            **gpt_auth,
        )

    return await _judge_until_verdict(judge)


def _iter_benchmark_messages(data: dict) -> list[dict]:
    """Root transcript plus every collected tree-node transcript.

    Browser sessions on this bench spawn from first-level GPs, not the root.
    Session-count checks must walk the same tree the FE paints.
    """
    seen_ids: set[str] = set()
    out: list[dict] = []

    def add(message: object) -> None:
        if not isinstance(message, dict):
            return
        message_id = str(message.get("message_id") or message.get("id") or "")
        if message_id:
            if message_id in seen_ids:
                return
            seen_ids.add(message_id)
        out.append(message)

    for message in data.get("messages") or []:
        add(message)
    tree = (data.get("_benchmark") or {}).get("tree") or {}
    if isinstance(tree, dict):
        for node in tree.values():
            if not isinstance(node, dict):
                continue
            for message in node.get("messages") or []:
                add(message)
    return out


def _skipped_browser_spawn_ids(messages: list[dict]) -> set[str]:
    """Tool-call ids whose browser spawn was FINISH-skipped (never a session)."""
    skipped: set[str] = set()
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict) or not metadata.get("skippedBrowserSpawn"):
            continue
        call_id = metadata.get("toolCallId") or metadata.get("tool_call_id")
        if call_id:
            skipped.add(str(call_id))
    return skipped


def _browser_agent_runtime_facts(data: dict) -> tuple[int, list[str]]:
    """Return distinct browser attempts and grounded failed lifecycle events."""
    failures: list[str] = []
    messages = _iter_benchmark_messages(data)
    for message_index, message in enumerate(messages):
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        message_text = _tool_message_body(message)
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            tool_name = candidate.get("toolName") or candidate.get("tool_name")
            is_browser = tool_name == "spawn_browser_agent" or (
                tool_name == "spawn_agent" and candidate.get("agentType") == "browser"
            )
            if not is_browser or candidate.get("skippedBrowserSpawn"):
                continue
            call_id = candidate.get("toolCallId") or candidate.get("tool_call_id")
            session_id = (
                candidate.get("task_id")
                or candidate.get("taskId")
                or candidate.get("subAgentId")
                or candidate.get("sub_agent_id")
                or candidate.get("world_model_session_id")
                or candidate.get("browser_session_id")
                or candidate.get("browser_url")
            )
            if _is_intermediate_browser_retry_failure(candidate, message if isinstance(message, dict) else None):
                continue
            if _is_recoverable_browser_element_miss_failure(
                candidate,
                message_text=message_text,
                messages=messages,
                message_index=message_index,
            ):
                continue
            if _is_recoverable_pinned_host_refusal_failure(
                candidate,
                message_text=message_text,
                messages=messages,
                message_index=message_index,
            ):
                continue
            if _is_recoverable_browser_evaluate_uncaught_failure(
                candidate,
                message_text=message_text,
                messages=messages,
                message_index=message_index,
            ):
                continue
            status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
            event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
            if status in {"CANCELLED", "ERROR", "FAILED"} or event_data.get("success") is False:
                failures.append(
                    f"{tool_name or 'browser agent'} {call_id or session_id or 'unknown'} "
                    f"status={status or 'unsuccessful'}"
                )
    # Browser actions have their own tool-call IDs. Counting those IDs directly
    # turns one seven-step browser into seven "sessions". Reuse the trajectory
    # grouper, which unions orchestration IDs, task IDs, and sub-agent IDs into
    # the stable browser instance while retaining separate browser attempts.
    browser_instances = _agent_class_step_counts({"messages": messages}).get("browser", {})
    return len(browser_instances), failures


_AGENT_CLASS_BY_RUNTIME_TOOL = {
    "spawn_browser_agent": "browser",
    "spawn_claude_code_agent": "code",
    "spawn_general_purpose_agent": "explore",
}
_AGENT_ORCHESTRATION_TOOLS = {
    "spawn_agent",
    "spawn_browser_agent",
    "spawn_claude_code_agent",
    "spawn_general_purpose_agent",
}


def _agent_class_step_counts(data: dict) -> dict[str, dict[str, int]]:
    """Count grounded trajectory steps for each spawned agent instance.

    Browser steps are deliberately strict: only explicit, non-negative
    ``steps_taken`` counters emitted by browser action events count. Lifecycle
    messages and terminal structured responses count as zero work. Other agent
    classes use the same per-instance grouping and count their distinct leaf
    tool calls, unless they expose explicit step counters of their own.
    """
    parents: dict[tuple[str, str], tuple[str, str]] = {}
    explicit_steps: dict[tuple[str, str], set[int]] = {}
    leaf_steps: dict[tuple[str, str], set[str]] = {}

    def register(agent_class: str, instance_id: object) -> tuple[str, str] | None:
        normalized_class = str(agent_class or "").strip().lower()
        normalized_id = str(instance_id or "").strip()
        if not normalized_class or not normalized_id:
            return None
        node = (normalized_class, normalized_id)
        parents.setdefault(node, node)
        return node

    def find(node: tuple[str, str]) -> tuple[str, str]:
        parent = parents[node]
        if parent != node:
            parents[node] = find(parent)
        return parents[node]

    def union(left: tuple[str, str], right: tuple[str, str]) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    messages = data.get("messages", []) or []
    skipped_browser_ids = _skipped_browser_spawn_ids([message for message in messages if isinstance(message, dict)])
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        for tool_call in metadata.get("tool_calls", []) or []:
            if not isinstance(tool_call, dict):
                continue
            tool_name = tool_call.get("tool")
            call_id = tool_call.get("tool_call_id") or tool_call.get("toolCallId")
            agent_class = tool_call.get("type") or _AGENT_CLASS_BY_RUNTIME_TOOL.get(tool_name)
            if str(call_id or "") in skipped_browser_ids and (
                tool_name == "spawn_browser_agent" or agent_class == "browser"
            ):
                continue
            if tool_name == "spawn_agent" or tool_name in _AGENT_CLASS_BY_RUNTIME_TOOL:
                register(agent_class, call_id)

    step_events: list[tuple[tuple[str, str], dict, bool]] = []
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            if candidate.get("skippedBrowserSpawn"):
                continue
            tool_name = candidate.get("toolName") or candidate.get("tool_name")
            agent_class = (
                candidate.get("agentType") or candidate.get("agent_type") or _AGENT_CLASS_BY_RUNTIME_TOOL.get(tool_name)
            )
            tool_call_id = candidate.get("toolCallId") or candidate.get("tool_call_id")
            if str(tool_call_id or "") in skipped_browser_ids and (
                tool_name == "spawn_browser_agent" or agent_class == "browser"
            ):
                continue
            if not agent_class:
                continue
            direct_ids = [
                candidate.get("subAgentId"),
                candidate.get("sub_agent_id"),
                candidate.get("task_id"),
                candidate.get("taskId"),
            ]
            nodes = [node for value in direct_ids if (node := register(agent_class, value))]
            if tool_name in _AGENT_ORCHESTRATION_TOOLS:
                tool_node = register(agent_class, tool_call_id)
                if tool_node:
                    nodes.append(tool_node)
            if not nodes:
                continue
            anchor = nodes[0]
            for node in nodes[1:]:
                union(anchor, node)
            has_direct_instance = any(value for value in direct_ids)
            step_events.append((anchor, candidate, has_direct_instance))

    for node, candidate, has_direct_instance in step_events:
        root = find(node)
        step_number = candidate.get("steps_taken")
        if isinstance(step_number, int) and not isinstance(step_number, bool) and step_number >= 0:
            explicit_steps.setdefault(root, set()).add(step_number)
        if root[0] == "browser" or not has_direct_instance:
            continue
        tool_name = candidate.get("toolName") or candidate.get("tool_name")
        tool_call_id = candidate.get("toolCallId") or candidate.get("tool_call_id")
        if tool_name and tool_name not in _AGENT_ORCHESTRATION_TOOLS and tool_call_id:
            leaf_steps.setdefault(root, set()).add(f"{tool_name}:{tool_call_id}")

    grouped_explicit: dict[tuple[str, str], set[int]] = {}
    grouped_leaf: dict[tuple[str, str], set[str]] = {}
    for node, values in explicit_steps.items():
        grouped_explicit.setdefault(find(node), set()).update(values)
    for node, values in leaf_steps.items():
        grouped_leaf.setdefault(find(node), set()).update(values)

    counts: dict[str, dict[str, int]] = {}
    for node in parents:
        root = find(node)
        if root != node:
            continue
        agent_class, instance_id = root
        explicit_count = len(grouped_explicit.get(root, set()))
        leaf_count = len(grouped_leaf.get(root, set()))
        counts.setdefault(agent_class, {})[instance_id] = explicit_count if explicit_count else leaf_count

    # Browser agents that die during session init (provider ReadTimeout before
    # session_init / browser_session_metadata) leave a 0-step instance. When the
    # root agent retries with a later spawn, counting the dead attempt as a
    # min_steps subject fails isolation benches even though the successful
    # browser did the work (webdecoy agent 2a421e78 / task 14184300). Keep the
    # empty instance when it is the only browser evidence so min_steps still
    # fails closed on "browser never started".
    browser_counts = counts.get("browser")
    if browser_counts:
        session_reached_ids = _browser_session_reached_ids(messages)
        session_reached_roots = {
            find(("browser", instance_id)) for instance_id in session_reached_ids if ("browser", instance_id) in parents
        }
        has_live_browser = any(
            actual > 0 or find(("browser", instance_id)) in session_reached_roots
            for instance_id, actual in browser_counts.items()
        )
        if has_live_browser:
            for instance_id, actual in list(browser_counts.items()):
                root = find(("browser", instance_id))
                if actual > 0 or root in session_reached_roots:
                    continue
                browser_counts.pop(instance_id, None)
            if not browser_counts:
                counts.pop("browser", None)

    return counts


def _browser_session_reached_ids(messages: list) -> set[str]:
    """Ids for browser instances that published live session evidence."""
    reached: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            action_type = str(candidate.get("action_type") or candidate.get("actionType") or "")
            status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
            has_session_meta = isinstance(candidate.get("browser_session_metadata"), dict)
            session_ready = action_type == "session_init" and status == "FINISHED"
            if not has_session_meta and not session_ready:
                continue
            for key in (
                "task_id",
                "taskId",
                "subAgentId",
                "sub_agent_id",
                "toolCallId",
                "tool_call_id",
            ):
                value = candidate.get(key)
                if value:
                    reached.add(str(value))
    return reached


def _validate_agent_class_min_steps(
    min_steps: dict[str, int],
    counts: dict[str, dict[str, int]],
) -> Optional[str]:
    """Require every observed instance of each configured class to meet its minimum."""
    for agent_class, minimum in sorted(min_steps.items()):
        instances = counts.get(agent_class, {})
        if not instances:
            return (
                f"No {agent_class} agent trajectory was recorded; expected at least "
                f"{minimum} steps per {agent_class} agent"
            )
        for instance_id, actual in sorted(instances.items()):
            if actual < minimum:
                return (
                    f"{agent_class.capitalize()} agent {instance_id} recorded {actual} trajectory "
                    f"step(s); expected at least {minimum} per {agent_class} agent"
                )
    return None


def _is_intermediate_challenge_recovery_failure(candidate: dict) -> bool:
    """Staged antibot recoveries often ERROR then continue; those are not tool failures.

    `recover_from_challenge` emits `action_type=browser_challenge_recovery` rows (often
    under synthetic `provider-exit-recovery-*` toolCallIds). A later successful payment
    boundary can follow after one or more of these ERRORs. Counting them in
    `no_tool_failures` / `no_browser_agent_failures` makes antibot benches fail closed
    on expected recovery noise.
    """
    action_type = str(candidate.get("action_type") or candidate.get("actionType") or "")
    if action_type == "browser_challenge_recovery":
        return True
    call_id = str(candidate.get("toolCallId") or candidate.get("tool_call_id") or "")
    return call_id.startswith("provider-exit-recovery-")


_ELEMENT_INDEX_NOT_FOUND_RE = re.compile(
    r"^Element with index \d+ not found\.?$",
    re.IGNORECASE,
)


def _browser_tool_candidate(candidate: dict) -> bool:
    tool_name = candidate.get("toolName") or candidate.get("tool_name")
    return tool_name == "spawn_browser_agent" or (
        tool_name == "spawn_agent" and candidate.get("agentType") == "browser"
    )


def _is_browser_element_index_miss(
    candidate: dict,
    *,
    message_text: str = "",
) -> bool:
    """True when a browser action failed only because a DOM index was stale."""
    if not _browser_tool_candidate(candidate):
        return False
    texts = [str(message_text or "").strip()]
    event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
    err = event_data.get("error")
    if err is not None:
        texts.append(str(err).strip())
    return any(bool(text) and _ELEMENT_INDEX_NOT_FOUND_RE.fullmatch(text) for text in texts)


def _has_later_browser_recovery(messages: list, start_index: int) -> bool:
    """True when a later browser event proves the session continued usefully."""
    for message in messages[start_index + 1 :]:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if not _browser_tool_candidate(metadata):
            continue
        status = str(metadata.get("toolStatus") or metadata.get("tool_status") or "").upper()
        action_type = str(metadata.get("action_type") or metadata.get("actionType") or "")
        if action_type in {"request_payment_card", "requestPaymentCard"} and status in {
            "FINISHED",
            "IN_PROGRESS",
        }:
            return True
        if status == "FINISHED" and action_type not in {"", "error"}:
            return True
    return False


def _has_later_web_fetch_recovery(messages: list, start_index: int) -> bool:
    """True when a later web_fetch FINISHED proves the agent recovered from a fetch ERROR."""
    for message in messages[start_index + 1 :]:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        tool_name = str(metadata.get("toolName") or metadata.get("tool_name") or "")
        if tool_name != "web_fetch":
            continue
        status = str(metadata.get("toolStatus") or metadata.get("tool_status") or "").upper()
        if status == "FINISHED":
            return True
    return False


_RECOVERABLE_EXPLORE_TOOLS = frozenset({"web_fetch", "web_search", "grep", "people_search"})


def _has_later_explore_tool_recovery(messages: list, start_index: int) -> bool:
    """True when later research progress proves the agent recovered from an explore-tool ERROR."""
    for message in messages[start_index + 1 :]:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        tool_name = str(metadata.get("toolName") or metadata.get("tool_name") or "")
        status = str(metadata.get("toolStatus") or metadata.get("tool_status") or "").upper()
        if status != "FINISHED":
            continue
        if tool_name in _RECOVERABLE_EXPLORE_TOOLS or tool_name in {
            "attempt_completion",
            "completion_summary",
        }:
            return True
    return False


def _is_recoverable_web_fetch_failure(
    candidate: dict,
    *,
    messages: list | None = None,
    message_index: int | None = None,
) -> bool:
    """Transient web_fetch ERRORs recovered by a later successful fetch are not tool failures.

    Explore / GP children often hit a one-off fetch ERROR (timeout, 403, soft page) and
    continue with alternate URLs. Counting those recovered rows in `no_tool_failures`
    fails closed Fast Mode mass-agent replays whose historical trajectories include a
    single recovered fetch ERROR (local repro: test-mass-agent-run-0 agent
    4f078c58… / child 84979949… web_fetch bf0a44fa… then 69 later FINISHED fetches).
    Unrecovered terminal web_fetch ERRORs still count.
    """
    tool_name = str(candidate.get("toolName") or candidate.get("tool_name") or "")
    if tool_name != "web_fetch":
        return False
    status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
    if status not in {"ERROR", "FAILED"}:
        return False
    if messages is None or message_index is None:
        return False
    return _has_later_web_fetch_recovery(messages, message_index)


def _is_recoverable_explore_tool_failure(
    candidate: dict,
    *,
    messages: list | None = None,
    message_index: int | None = None,
) -> bool:
    """Explore-tool ERRORs recovered by later research/completion are not harness failures.

    Fast Mode mass-agent cache trajectories include schema-invalid grep calls
    (`Unsupported grep parameter: 'filters'`) and transient web_fetch ERRORs; children
    pivot to web_search / alternate URLs and still COMPLETE. Local repro:
    test-mass-agent-run-0 agent 65558d55… / child 5af074c9… had 3 unrecovered-by-same-tool
    grep ERRORs then continued with dozens of FINISHED web_search calls. Unrecovered
    terminal explore ERRORs (no later research/completion FINISHED) still count.
    """
    tool_name = str(candidate.get("toolName") or candidate.get("tool_name") or "")
    if tool_name not in _RECOVERABLE_EXPLORE_TOOLS:
        return False
    status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
    if status not in {"ERROR", "FAILED"}:
        return False
    if messages is None or message_index is None:
        return False
    return _has_later_explore_tool_recovery(messages, message_index)


def _is_recoverable_browser_element_miss_failure(
    candidate: dict,
    *,
    message_text: str = "",
    messages: list | None = None,
    message_index: int | None = None,
) -> bool:
    """Stale DOM index ERRORs often happen mid-run; recovered ones are not tool failures.

    Browser agents frequently hit `Element with index N not found` after a DOM refresh,
    then continue (scroll/click/payment). Counting those recovered ERRORs in
    `no_tool_failures` / `no_browser_agent_failures` fails closed payment-terminal benches
    that still reach `requestPaymentCard`. Unrecovered terminal misses still count.
    """
    if not _is_browser_element_index_miss(candidate, message_text=message_text):
        return False
    if messages is None or message_index is None:
        return False
    return _has_later_browser_recovery(messages, message_index)


_PINNED_HOST_REFUSAL_RE = re.compile(
    r"Refusing (?:to leave pinned page host|click that navigates off pinned host|"
    r"key chord .+ that would leave pinned host|"
    r"evaluate that would navigate away from pinned host)",
    re.IGNORECASE,
)


def _is_browser_pinned_host_refusal(
    candidate: dict,
    *,
    message_text: str = "",
) -> bool:
    """True when the browser guard refused leaving an antibot-pinned host."""
    if not _browser_tool_candidate(candidate):
        return False
    parts = [str(message_text or "").strip()]
    for key in ("error", "title", "detail", "details"):
        value = candidate.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
    for key in ("error", "message", "detail"):
        value = event_data.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return bool(_PINNED_HOST_REFUSAL_RE.search("\n".join(parts)))


def _is_recoverable_pinned_host_refusal_failure(
    candidate: dict,
    *,
    message_text: str = "",
    messages: list | None = None,
    message_index: int | None = None,
) -> bool:
    """Pinned-host guard ERRORs during challenge pin are retry noise when later recovered.

    While a Google/Cloudflare (etc.) page is pinned, escape attempts (close_tab,
    switch_tab, off-host click, navback, Ctrl+W, evaluate navigate) ERROR with
    `Refusing … pinned host`. Agents often recover and still reach payment.
    Counting those recovered refusals in `no_tool_failures` fails closed
    payment-terminal benches. Unrecovered terminal refusals still count.
    """
    if not _is_browser_pinned_host_refusal(candidate, message_text=message_text):
        return False
    if messages is None or message_index is None:
        return False
    return _has_later_browser_recovery(messages, message_index)


_PAGE_EVALUATE_UNCAUGHT_RE = re.compile(
    r"^Uncaught(?:\s|$)",
    re.IGNORECASE,
)


def _is_browser_page_evaluate_uncaught(
    candidate: dict,
    *,
    message_text: str = "",
) -> bool:
    """True when a page ``evaluate`` action failed with a truncated JS Uncaught error.

    Kernel/CDP often surfaces page-script exceptions as the bare token ``Uncaught``
    (or ``Uncaught TypeError: …``) on ``action_type=error`` rows whose title is
    ``evaluate``. That is page-side noise the browser agent is expected to retry
    around — not a harness/tool crash.
    """
    if not _browser_tool_candidate(candidate):
        return False
    title = str(candidate.get("title") or "").strip().lower()
    action_type = str(candidate.get("action_type") or candidate.get("actionType") or "").strip().lower()
    # ERROR lifecycle rewrites action_type to ``error``; title keeps ``evaluate``.
    if title != "evaluate" and action_type != "evaluate":
        return False
    texts = [str(message_text or "").strip()]
    event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
    err = event_data.get("error")
    if err is not None:
        texts.append(str(err).strip())
    for key in ("error", "detail", "details"):
        value = candidate.get(key)
        if isinstance(value, str) and value.strip():
            texts.append(value.strip())
    return any(bool(text) and _PAGE_EVALUATE_UNCAUGHT_RE.match(text) for text in texts)


def _is_recoverable_browser_evaluate_uncaught_failure(
    candidate: dict,
    *,
    message_text: str = "",
    messages: list | None = None,
    message_index: int | None = None,
) -> bool:
    """Page-evaluate Uncaught ERRORs recovered before payment are not tool failures.

    Local repro: browser-imax-group-tickets agent
    ``482d6aa2-90f0-4173-95a4-f51bfbce2055`` reached grounded payment_approval
    ($89.94 AMC) after ``spawn_browser_agent`` ERROR message ``Uncaught``
    (title ``evaluate``), then failed only on ``no_tool_failures``. Unrecovered
    terminal Uncaught rows still count.
    """
    if not _is_browser_page_evaluate_uncaught(candidate, message_text=message_text):
        return False
    if messages is None or message_index is None:
        return False
    return _has_later_browser_recovery(messages, message_index)


def _tool_message_body(message: dict) -> str:
    """Return tool/user-visible body text from either API (`text`) or artifact (`message`)."""
    return str(message.get("text") or message.get("message") or "")


def _message_failure_text(message: Optional[dict], candidate: dict) -> str:
    """Join transcript + metadata error surfaces for intermediate-failure classifiers.

    Agent GET payloads use `text` (see `extract_message_transcript`); archived
    run JSON often remaps that to `message`. Read both so live eval and offline
    replay classify the same ERROR rows.
    """
    parts: list[str] = []
    if isinstance(message, dict):
        parts.append(str(message.get("text") or message.get("message") or message.get("content") or ""))
    for key in ("error", "title", "detail", "details", "message"):
        value = candidate.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
    for key in ("error", "message", "detail"):
        value = event_data.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    return "\n".join(parts)


def _is_intermediate_stale_dom_node_failure(candidate: dict, message: Optional[dict] = None) -> bool:
    """Stale DOM indexes / invalid CDP backendNodeIds ERROR then the browser agent retries.

    SPA remounts (Amazon checkout re-auth, etc.) invalidate selector-map indexes. Humanize
    then refuses click/TypeTextEvent with `Cannot humanize … no coordinates available`
    (CDP often reports `No node found for given backend id` underneath). The browser
    agent is expected to re-observe and retry; counting those rows in `no_tool_failures`
    / `no_browser_agent_failures` fails closed on expected retry noise after a later
    grounded write-lock / payment boundary.
    """
    tool_name = candidate.get("toolName") or candidate.get("tool_name")
    is_browser = tool_name == "spawn_browser_agent" or (
        tool_name == "spawn_agent" and candidate.get("agentType") == "browser"
    )
    if not is_browser:
        return False
    blob = _message_failure_text(message, candidate).lower()
    if "cannot humanize" in blob and "no coordinates available" in blob:
        return True
    return "no node found for given backend id" in blob or "no node with given id found" in blob


def _is_intermediate_evaluate_hard_recovery_failure(candidate: dict, message: Optional[dict] = None) -> bool:
    """Frozen-renderer hard-recovery ERRORs are intentional supervisor noise, not tool failures.

    When the page renderer freezes (`renderer_main_thread_blocked`), any action
    (evaluate, click, …) can time out; the supervisor emits an `action_type=error`
    row after hard recovery (new context/page), then the agent continues. Counting
    those rows in `no_tool_failures` fails closed on expected recovery protocol —
    the same class as challenge-recovery ERRORs (see Eventim) once a later grounded
    payment boundary is reachable.
    """
    tool_name = candidate.get("toolName") or candidate.get("tool_name")
    is_browser = tool_name == "spawn_browser_agent" or (
        tool_name == "spawn_agent" and candidate.get("agentType") == "browser"
    )
    if not is_browser:
        return False
    blob = _message_failure_text(message, candidate).lower()
    if "hard renderer recovery" in blob and "renderer_main_thread_blocked" in blob:
        return True
    return "action_timeout_" in blob and "hard renderer recovery" in blob


def _is_intermediate_navigation_pin_guard_failure(
    candidate: dict,
    message: Optional[dict] = None,
) -> bool:
    """Explicit `navigation_pin_guard` action rows are intermediate coaching only.

    Textual `Refusing … pinned host` ERRORs are handled by
    `_is_recoverable_pinned_host_refusal_failure` (requires a later browser
    recovery). Do not treat every pinned-host refusal string as retry noise —
    unrecovered terminal refusals must still fail `no_tool_failures`.

    Local repro: browser-doordash-usb-c-cable agent
    b1eb2afd-bb3a-4d79-9cd9-dcce8142fd4b reached an unresolved Place Order write_lock
    after an evaluate pin-guard ERROR; recovery-gated pinned-host classification
    covers that path.
    """
    _ = message  # signature matches sibling intermediate classifiers
    action_type = str(candidate.get("action_type") or candidate.get("actionType") or "")
    return action_type == "navigation_pin_guard"


def _is_intermediate_browser_retry_failure(candidate: dict, message: Optional[dict] = None) -> bool:
    """True when a browser-agent ERROR is expected recovery / retry noise."""
    return (
        _is_intermediate_challenge_recovery_failure(candidate)
        or _is_intermediate_stale_dom_node_failure(candidate, message)
        or _is_intermediate_evaluate_hard_recovery_failure(candidate, message)
        or _is_intermediate_navigation_pin_guard_failure(candidate, message)
    )


_EXPLORE_RESEARCH_TOOLS = frozenset({"web_search", "web_fetch", "grep", "people_search"})


def _message_tool_meta(message: dict) -> dict:
    metadata = message.get("metadata") if isinstance(message, dict) else None
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    return metadata if isinstance(metadata, dict) else {}


def _explore_reject_loop_failures(data: dict, *, min_rejects: int = 2) -> list[str]:
    """GP explore chips that only reject completion (no search/fetch) are broken."""
    failures: list[str] = []

    def consider(messages: list, label: str) -> None:
        by_task: dict[str, dict[str, int]] = {}
        for message in messages or []:
            if not isinstance(message, dict):
                continue
            metadata = _message_tool_meta(message)
            tool_name = str(metadata.get("toolName") or metadata.get("tool_name") or "")
            title = str(metadata.get("title") or "")
            task_id = str(metadata.get("taskId") or metadata.get("subAgentId") or metadata.get("agentId") or "")
            if not task_id:
                continue
            stats = by_task.setdefault(task_id, {"rejects": 0, "research": 0})
            if "attempt_completion_with_result rejected" in title:
                stats["rejects"] += 1
            if tool_name in _EXPLORE_RESEARCH_TOOLS:
                stats["research"] += 1
        for task_id, stats in by_task.items():
            if stats["rejects"] >= min_rejects and stats["research"] == 0:
                failures.append(
                    f"{label} explore {task_id[:8]} had {stats['rejects']} "
                    "attempt_completion_with_result rejects and 0 research tools"
                )

    consider(data.get("messages") or [], "root")
    tree = _judge_source_tree(data)
    for agent_id, node in tree.items():
        if not isinstance(node, dict):
            continue
        consider(node.get("messages") or [], f"gp {str(agent_id)[:8]}")
    return failures


_EXPLORE_SUMMARY_STUBS = frozenset({"research started.", "research started"})
_EXPLORE_SUMMARY_FORBIDDEN = (
    "fast mode",
    "cached trajectory",
    "verified results are included below",
    "without a final summary",
    "raw tool results below",
)


def _explore_chip_summary_failures(data: dict, *, min_chars: int = 200) -> list[str]:
    """GP explore chips that research but never post a user-facing wrap-up."""
    failures: list[str] = []

    def consider(messages: list, label: str) -> None:
        by_task: dict[str, dict[str, int]] = {}
        for message in messages or []:
            if not isinstance(message, dict):
                continue
            metadata = _message_tool_meta(message)
            if str(metadata.get("agentType") or "") != "explore":
                continue
            task_id = str(metadata.get("taskId") or metadata.get("subAgentId") or metadata.get("agentId") or "")
            if not task_id:
                continue
            stats = by_task.setdefault(task_id, {"research": 0, "best": 0})
            tool_name = str(metadata.get("toolName") or metadata.get("tool_name") or "")
            if tool_name in _EXPLORE_RESEARCH_TOOLS:
                stats["research"] += 1
            title = str(metadata.get("title") or "")
            if title == "Explore agent thinking":
                continue
            if tool_name != "spawn_agent":
                continue
            if str(metadata.get("toolStatus") or "").upper() != "FINISHED":
                continue
            body = str(message.get("message") or message.get("text") or "").strip()
            if not body or body.lower() in _EXPLORE_SUMMARY_STUBS:
                continue
            lowered = body.lower()
            if any(marker in lowered for marker in _EXPLORE_SUMMARY_FORBIDDEN):
                continue
            stats["best"] = max(stats["best"], len(body))
        for task_id, stats in by_task.items():
            if stats["research"] == 0:
                continue
            if stats["best"] < min_chars:
                failures.append(
                    f"{label} explore {task_id[:8]} replayed {stats['research']} research tools "
                    f"but the chip summary is {stats['best']} chars (need >= {min_chars})"
                )

    consider(data.get("messages") or [], "root")
    tree = _judge_source_tree(data)
    for agent_id, node in tree.items():
        if not isinstance(node, dict):
            continue
        consider(node.get("messages") or [], f"gp {str(agent_id)[:8]}")
    return failures


def _all_trajectory_messages(data: dict) -> list[tuple[list, str]]:
    """Return (messages, agent_label) pairs for root + captured benchmark tree."""
    sections: list[tuple[list, str]] = []
    root_messages = data.get("messages", []) or []
    if root_messages:
        sections.append((root_messages, "root"))
    tree = data.get("_benchmark", {}).get("tree") if isinstance(data.get("_benchmark"), dict) else None
    if isinstance(tree, dict):
        for agent_id, info in tree.items():
            if not isinstance(info, dict):
                continue
            messages = info.get("messages") or []
            if messages:
                sections.append((messages, str(agent_id)[:8]))
    return sections


def _tool_runtime_failures(data: dict) -> list[str]:
    """Return grounded failed tool lifecycle events from root + tree trajectories."""
    failures: list[str] = []
    for messages, agent_label in _all_trajectory_messages(data):
        for message_index, message in enumerate(messages):
            metadata = message.get("metadata") if isinstance(message, dict) else None
            if not isinstance(metadata, dict):
                continue
            message_text = _tool_message_body(message)
            candidates = [metadata]
            if isinstance(metadata.get("auxiliary"), dict):
                candidates.append(metadata["auxiliary"])
            for candidate in candidates:
                tool_name = candidate.get("toolName") or candidate.get("tool_name")
                if not tool_name:
                    continue
                if _is_intermediate_browser_retry_failure(candidate, message if isinstance(message, dict) else None):
                    continue
                if _is_recoverable_browser_element_miss_failure(
                    candidate,
                    message_text=message_text,
                    messages=messages,
                    message_index=message_index,
                ):
                    continue
                if _is_recoverable_pinned_host_refusal_failure(
                    candidate,
                    message_text=message_text,
                    messages=messages,
                    message_index=message_index,
                ):
                    continue
                if _is_recoverable_browser_evaluate_uncaught_failure(
                    candidate,
                    message_text=message_text,
                    messages=messages,
                    message_index=message_index,
                ):
                    continue
                if _is_recoverable_web_fetch_failure(
                    candidate,
                    messages=messages,
                    message_index=message_index,
                ):
                    continue
                if _is_recoverable_explore_tool_failure(
                    candidate,
                    messages=messages,
                    message_index=message_index,
                ):
                    continue
                status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
                event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
                if status in {"CANCELLED", "ERROR", "FAILED"} or event_data.get("success") is False:
                    call_id = candidate.get("toolCallId") or candidate.get("tool_call_id") or "unknown"
                    prefix = f"{agent_label}:" if agent_label != "root" else ""
                    failures.append(f"{prefix}{tool_name} {call_id} status={status or 'unsuccessful'}")
    return failures


def _root_assemble_deliverables(data: dict) -> list[dict]:
    """July Fast Mode lands the real deliverable in DAG reasoning ASSISTANT chips."""
    deliverables: list[dict] = []
    for message in data.get("messages") or []:
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").upper() != "ASSISTANT":
            continue
        text = _message_text_for_judge(message)
        if len(text) < 1000:
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        is_assemble = (
            metadata.get("plannedToolName") == "reasoning"
            or metadata.get("dagTaskIndex") is not None
            or str(metadata.get("streamId") or "").startswith("dag-")
        )
        if not is_assemble:
            continue
        deliverables.append({"text": text, "chars": len(text)})
    deliverables.sort(key=lambda item: item["chars"], reverse=True)
    return deliverables[:4]


def _root_deliverable_blob(data: dict) -> str:
    parts = [str(summary.get("summary") or "") for summary in _final_completion_summaries(data)]
    parts.extend(item["text"] for item in _root_assemble_deliverables(data))
    return "\n".join(part for part in parts if part)


def _root_final_answer_blob(data: dict) -> str:
    """Root deliverable prose plus the structured outputs its Task Complete card shows the user."""
    parts = [_root_deliverable_blob(data)]
    for summary in _final_completion_summaries(data):
        for output in summary.get("outputs") or []:
            if isinstance(output, dict) and output.get("value") not in (None, ""):
                parts.append(f"{output.get('label') or output.get('key')}: {output.get('value')}")
    return "\n".join(part for part in parts if part)


def _final_completion_summaries(data: dict) -> list[dict]:
    """Return durable root completion cards in transcript order."""
    return _completion_cards_from_messages(data.get("messages", []) or [])


def _completion_cards_from_messages(messages: list) -> list[dict]:
    from benchmarks.completion_evidence import completion_card, completion_messages

    return [completion_card(message["metadata"]) for message in completion_messages(messages)]


def _task_declares_static_check(task: BenchmarkTask, check_type: str) -> bool:
    """Return True when any declared static_check evaluator includes check_type."""
    return any(
        check.get("type") == check_type
        for evaluator in task.evaluators
        if evaluator.get("method") == "static_check"
        for check in evaluator.get("checks", [])
    )


def _completion_cards_for_static_check(data: dict, *, include_first_level_gps: bool) -> list[dict]:
    """Root Task Complete cards, plus first-level GP cards when requested."""
    cards: list[dict] = []
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "root")
    for summary in _final_completion_summaries(data):
        cards.append(
            {
                "agent_id": root_id,
                "summary": summary.get("summary"),
                "outputs": summary.get("outputs"),
            }
        )
    if not include_first_level_gps:
        return cards
    compact = _compact_benchmark_state_for_judge(data)
    tree = _judge_source_tree(data)
    for gp in compact.get("first_level_gps") or []:
        agent_id = str(gp.get("agent_id") or "")
        node = tree.get(agent_id) if isinstance(tree.get(agent_id), dict) else {}
        gp_cards = _completion_cards_from_messages(node.get("messages") or [])
        if not gp_cards:
            cards.append({"agent_id": agent_id or "gp", "summary": "", "outputs": []})
            continue
        last = gp_cards[-1]
        cards.append(
            {
                "agent_id": agent_id or "gp",
                "summary": last.get("summary"),
                "outputs": last.get("outputs"),
            }
        )
    return cards


def _synthetic_agent_skip_failures(data: dict) -> list[str]:
    """Visible FINISHED placeholders for cached GP/code actions are not real work."""
    failures: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    sources: list[tuple[str, list]] = [("root", data.get("messages") or [])]
    # Do not scan only the merged judge tree: its longest-transcript preference
    # intentionally drops a shorter duplicate node. A forbidden user-visible
    # card in either raw source must still fail this criterion.
    for tree in _judge_source_trees(data):
        for agent_id, node in tree.items():
            if isinstance(node, dict):
                sources.append((str(agent_id), node.get("messages") or []))
    for agent_id, messages in sources:
        for message in messages:
            if not isinstance(message, dict):
                continue
            metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
            text = str(message.get("message") or message.get("text") or "").strip()
            title = str(metadata.get("title") or "")
            agent_type = str(metadata.get("agentType") or metadata.get("agent_type") or "")
            is_skipped = bool(metadata.get("skippedNestedSpawn")) or (
                title == "spawn_agent complete"
                and agent_type in {"general_purpose", "for_each", "code"}
                and "skipping" in text.lower()
            )
            if not is_skipped:
                continue
            signature = (agent_id, str(metadata.get("toolCallId") or ""), text)
            if signature in seen:
                continue
            seen.add(signature)
            failures.append(f"{agent_id[:8]} {agent_type or 'agent'}: {text or title}")
    return failures


def _agent_task_title_check(data: dict, check: dict) -> tuple[bool, str]:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    title = str(agent.get("title") or agent.get("name") or "").strip()
    if not title:
        return False, "Root task title is missing"
    forbidden = {str(item).strip().casefold() for item in check.get("forbidden_titles", []) if str(item).strip()}
    if title.casefold() in forbidden:
        return False, f"Root task title {title!r} is generic"
    expected = str(check.get("value") or check.get("expected_title") or "").strip()
    if expected and title != expected:
        return False, f"Root task title was {title!r}; expected {expected!r}"
    return True, "All declared static checks passed"


def _iter_completion_output_file_pointers(outputs: object) -> list[dict]:
    """Collect FilePointer-shaped values from Task Complete outputs (single or list)."""
    pointers: list[dict] = []
    if not isinstance(outputs, list):
        return pointers
    for item in outputs:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            filename = candidate.get("original_filename")
            storage_path = candidate.get("storage_path")
            if (
                isinstance(filename, str)
                and filename.strip()
                and isinstance(storage_path, str)
                and storage_path.strip()
            ):
                pointers.append(candidate)
    return pointers


def _response_schema_has_file_pointer_check(data: dict, check: dict) -> tuple[bool, str]:
    """Require the agent's generated response_schema to include a file_pointer field.

    Format constraints belong on produced FilePointer mime_type/extension
    (see completion_summary_file_outputs), not a second schema field.
    """
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    schema = agent.get("response_schema") or agent.get("output_schema") or {}
    fields = schema.get("fields") if isinstance(schema, dict) else None
    if not isinstance(fields, list) or not fields:
        return False, "response_schema missing fields"
    file_fields = [f for f in fields if isinstance(f, dict) and f.get("type") in ("file_pointer", "list[file_pointer]")]
    if not file_fields:
        types = [str(f.get("type")) for f in fields if isinstance(f, dict)]
        return False, f"response_schema has no file_pointer field (types={types})"
    return True, f"Found {len(file_fields)} file_pointer field(s)"


def _completion_summary_file_outputs_check(data: dict, check: dict) -> tuple[bool, str]:
    """Require Task Complete outputs to include FilePointers matching extension/mime filters."""
    cards = _completion_cards_for_static_check(
        data,
        include_first_level_gps=bool(check.get("include_first_level_gps")),
    )
    if not cards:
        return False, "No finished completion summary was observed"

    extensions = [
        str(ext).lower() if str(ext).startswith(".") else f".{str(ext).lower()}"
        for ext in (check.get("extensions") or [])
        if str(ext).strip()
    ]
    mime_contains = [str(part).lower() for part in (check.get("mime_contains") or []) if str(part).strip()]
    min_files = int(check.get("min_files", 1))

    matched: list[dict] = []
    for card in cards:
        for pointer in _iter_completion_output_file_pointers(card.get("outputs")):
            filename = str(pointer.get("original_filename") or "").lower()
            mime = str(pointer.get("mime_type") or "").lower()
            if extensions and not any(filename.endswith(ext) for ext in extensions):
                continue
            if mime_contains and not any(part in mime for part in mime_contains):
                continue
            matched.append(pointer)

    if len(matched) < min_files:
        detail = f"extensions={extensions or ['*']}, mime_contains={mime_contains or ['*']}"
        return (
            False,
            f"Task Complete outputs had {len(matched)} matching file_pointer(s); "
            f"expected at least {min_files} ({detail})",
        )
    return True, f"Found {len(matched)} matching file_pointer output(s)"


async def _hydrate_code_bench_results(task: BenchmarkTask, data: dict) -> None:
    """Grade the returned code-bench archive once, before static checks and the screenshot judge."""
    from benchmarks import code_bench

    fixture_ids, needs_screenshot = code_bench.needed_fixtures(task.evaluators)
    if not fixture_ids:
        return
    pointers = [
        pointer
        for card in _completion_cards_for_static_check(data, include_first_level_gps=False)
        for pointer in _iter_completion_output_file_pointers(card.get("outputs"))
    ]
    await code_bench.hydrate(data, fixture_ids, pointers, capture_screenshot=needs_screenshot)


async def _hydrate_completion_sms_events(data: dict) -> None:
    """Attach durable completion-SMS provider receipts for static evaluators."""
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_agent_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
    benchmark_state = data.setdefault("_benchmark", {})
    if not root_agent_id:
        benchmark_state["completion_sms_events"] = []
        benchmark_state["completion_sms_evidence_error"] = "root agent id is missing"
        return

    prefix = "provider/sms/notify/completion-"
    suffix = ".json.gz.enc"
    try:
        paths = await asyncio.to_thread(archive_artifact_paths, root_agent_id)
        completion_paths = sorted(path for path in paths if path.startswith(prefix) and path.endswith(suffix))
        events: list[dict] = []
        for path in completion_paths:
            receipt = await asyncio.to_thread(read_archive_json, root_agent_id, path)
            events.append({"path": path, **receipt})
        benchmark_state["completion_sms_events"] = events
    except Exception as exc:
        benchmark_state["completion_sms_events"] = []
        benchmark_state["completion_sms_evidence_error"] = str(exc)[:300]


_APPROVAL_CLOCK_RE = re.compile(
    r"(?:\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b)",
    re.IGNORECASE,
)
_APPROVAL_DATE_RE = re.compile(
    r"(?:\b\d{4}-\d{1,2}-\d{1,2}\b|"
    r"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|"
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|"
    r"dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b)",
    re.IGNORECASE,
)
_APPROVAL_AMOUNT_RE = re.compile(
    r"(?:\$\s*\d+(?:,\d{3})*(?:\.\d{2})?|\bUSD\s*\d+(?:,\d{3})*(?:\.\d{2})?\b|\b\d+(?:\.\d{2})?\s*USD\b)",
    re.IGNORECASE,
)
_APPROVAL_SEAT_TOKEN_RE = re.compile(r"\b[a-z]{1,2}\s*-?\s*\d{1,3}\b", re.IGNORECASE)


def _claude_code_sessions_with_transcripts(sessions: list[dict], *, min_chars: int = 1) -> list[dict]:
    """Return sessions whose stored terminal output meets ``min_chars``."""
    return [
        session
        for session in sessions
        if isinstance(session, dict)
        and isinstance(session.get("output"), str)
        and len(session.get("output", "").strip()) >= min_chars
    ]


def _claude_code_started_task_ids(messages: list) -> set[str]:
    """Return task_ids that have a claude_code_started (or equivalent) chip anchor."""
    started: set[str] = set()
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        task_id = metadata.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        action_type = metadata.get("action_type")
        if action_type in {"claude_code_started", "task_started"} or (
            metadata.get("toolName") == "spawn_claude_code_agent" and metadata.get("ws_url")
        ):
            started.add(task_id)
    return started


def _claude_code_terminal_task_ids(messages: list) -> set[str]:
    """Return task_ids that have a chip-terminal task_complete/session_cancelled."""
    terminal: set[str] = set()
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        task_id = metadata.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        if metadata.get("action_type") in {"task_complete", "session_cancelled"}:
            terminal.add(task_id)
    return terminal


async def _await_claude_code_chip_terminality(
    base_url: str,
    agent_id: str,
    data: dict,
    *,
    timeout_seconds: float = 45.0,
) -> dict:
    """After pause, wait until Claude Code chips have task_complete+task_id in-transcript.

    Pause cancel is async (activity cleanup posts Session Cancelled). Collecting
    logs immediately freezes the durable hub FE on "Spinning up..." because the
    archive misses the terminal message (hub agent 094f1085 had 87 msgs without
    cancel; local agent had 89 with Session Cancelled + task_id).
    """
    latest = data
    deadline = time.monotonic() + timeout_seconds
    while True:
        messages = latest.get("messages") or []
        started = _claude_code_started_task_ids(messages)
        if not started:
            return latest
        terminal = _claude_code_terminal_task_ids(messages)
        if started <= terminal:
            print(f"    ✓ Claude Code chip terminality settled ({len(terminal)}/{len(started)} task_complete+task_id)")
            return latest
        if time.monotonic() >= deadline:
            missing = sorted(started - terminal)
            print(
                f"    ⚠ Claude Code cancel messages incomplete before log collection; missing task_id(s): {missing[:5]}"
            )
            return latest
        await asyncio.sleep(1.5)
        try:
            latest = _retain_harness_benchmark_state(data, await get_agent(base_url, agent_id))
        except Exception as refresh_error:
            print(f"    ⚠ post-pause agent refresh failed: {refresh_error}")


async def _hydrate_claude_code_sessions(data: dict) -> None:
    """Fetch Claude Code sessions (root + tree) for transcript static checks.

    On timeout/early-fail the harness pauses the agent before evaluators run, but
    ``spawn_claude_code_agent`` persists terminal output asynchronously on cancel.
    Retry briefly when sessions exist yet still have empty ``output`` so the
    static check does not race the cancel-persist path.
    """
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root_agent_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
    benchmark_state = data.setdefault("_benchmark", {})
    base_url = str(benchmark_state.get("api_base_url") or "").rstrip("/")
    if not root_agent_id:
        benchmark_state["claude_code_sessions"] = []
        benchmark_state["claude_code_session_evidence_error"] = "root agent id is missing"
        return
    if not base_url:
        benchmark_state["claude_code_sessions"] = []
        benchmark_state["claude_code_session_evidence_error"] = "api_base_url is missing"
        return

    agent_ids = {root_agent_id}
    try:
        tree_agents = await get_agent_tree(base_url, root_agent_id)
        for node in tree_agents or []:
            if not isinstance(node, dict):
                continue
            aid = str(node.get("agent_id") or node.get("id") or "").strip()
            if aid:
                agent_ids.add(aid)
    except Exception as tree_exc:
        benchmark_state["claude_code_session_tree_error"] = str(tree_exc)[:200]

    # Pause → cancel → persist can lag the evaluator by a few seconds. Poll until
    # at least one session has a non-empty transcript (or we exhaust the budget).
    retry_deadline = time.monotonic() + 45.0
    sessions_by_id: dict[str, dict] = {}
    fetch_errors: list[str] = []
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                sessions_by_id = {}
                fetch_errors = []
                for aid in sorted(agent_ids):
                    try:
                        resp = await client.get(
                            f"{base_url}/api/claude-code-session/agent/{aid}",
                            headers=headers,
                        )
                        if resp.status_code != 200:
                            fetch_errors.append(f"{aid[:8]}:HTTP {resp.status_code}")
                            continue
                        payload = resp.json() if resp.content else {}
                        for session in payload.get("sessions") or []:
                            if not isinstance(session, dict):
                                continue
                            session_id = str(session.get("id") or "").strip()
                            if session_id:
                                sessions_by_id[session_id] = session
                    except Exception as fetch_exc:
                        fetch_errors.append(f"{aid[:8]}:{fetch_exc}")

                sessions = list(sessions_by_id.values())
                if not sessions:
                    break
                if _claude_code_sessions_with_transcripts(sessions):
                    break
                if time.monotonic() >= retry_deadline:
                    break
                await asyncio.sleep(2.0)

        benchmark_state["claude_code_sessions"] = list(sessions_by_id.values())
        if fetch_errors and not sessions_by_id:
            benchmark_state["claude_code_session_evidence_error"] = "; ".join(fetch_errors)[:300]
    except Exception as exc:
        benchmark_state["claude_code_sessions"] = []
        benchmark_state["claude_code_session_evidence_error"] = str(exc)[:300]


def _approval_user_visible_text(request: dict) -> str:
    """Return only approval copy shown to the user, excluding opaque IDs."""
    return " ".join(str(request.get(key) or "") for key in ("question", "message", "description")).lower()


def _approval_request_satisfies_detail_check(
    request: dict,
    check: dict,
    *,
    user_visible_only: bool = False,
) -> bool:
    evidence = _approval_user_visible_text(request) if user_visible_only else json.dumps(request, default=str).lower()
    required_strings = check.get("required_strings") or []
    if not all(str(value).lower() in evidence for value in required_strings):
        return False
    require_date = check.get("require_date") is True
    minimum_date_count = int(check.get("minimum_date_count", 1 if require_date else 0))
    if len(_APPROVAL_DATE_RE.findall(evidence)) < minimum_date_count:
        return False
    if check.get("require_time") is True and not _APPROVAL_CLOCK_RE.search(evidence):
        return False
    if check.get("require_amount") is True and not _APPROVAL_AMOUNT_RE.search(evidence):
        return False
    minimum_seat_count = int(check.get("minimum_seat_count", 1 if check.get("require_seat") is True else 0))
    if minimum_seat_count:
        seat_tokens = {re.sub(r"\s+|-", "", token.lower()) for token in _APPROVAL_SEAT_TOKEN_RE.findall(evidence)}
        if len(seat_tokens) < minimum_seat_count:
            return False
    return True


def _approval_request_detail_failure(check: dict) -> str:
    required_strings = check.get("required_strings") or []
    minimum_date_count = int(check.get("minimum_date_count", 1 if check.get("require_date") is True else 0))
    minimum_seat_count = int(check.get("minimum_seat_count", 1 if check.get("require_seat") is True else 0))
    missing = ", ".join(str(value) for value in required_strings) or "required details"
    if minimum_date_count == 1:
        date_suffix = " and a calendar date"
    elif minimum_date_count > 1:
        date_suffix = f" and {minimum_date_count} calendar dates"
    else:
        date_suffix = ""
    time_suffix = " and a reservation time" if check.get("require_time") is True else ""
    amount_suffix = " and a monetary amount" if check.get("require_amount") is True else ""
    if minimum_seat_count == 1:
        seat_suffix = " and a seat assignment"
    elif minimum_seat_count > 1:
        seat_suffix = f" and {minimum_seat_count} distinct seat assignments"
    else:
        seat_suffix = ""
    return f"Approval request did not include {missing}{date_suffix}{time_suffix}{amount_suffix}{seat_suffix}"


def _run_declared_static_check(
    task_or_evaluator: BenchmarkTask | dict,
    evaluator_or_data: dict,
    data: Optional[dict] = None,
) -> tuple[bool, str]:
    """Execute the small fail-closed static-check surface used by enforced tasks."""
    if data is None:
        task: Optional[BenchmarkTask] = None
        evaluator = task_or_evaluator if isinstance(task_or_evaluator, dict) else {}
        data = evaluator_or_data
    else:
        task = task_or_evaluator if isinstance(task_or_evaluator, BenchmarkTask) else None
        evaluator = evaluator_or_data
    benchmark_state = data.get("_benchmark", {})
    for check in evaluator.get("checks", []):
        check_type = check.get("type")
        if check_type == "kill_agent_subtree":
            evidence = data.get("kill_agent_benchmark") or {}
            if evidence.get("ok") is not True:
                return False, f"Kill subtree lifecycle not verified: {evidence}"
            continue
        if check_type in TREE_ROUTING_CHECK_TYPES:
            ok, reason = check_tree_feedback_routing(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "process_trace":
            from benchmarks.process_bench import check_process_trace, spec_hash

            if task is None or getattr(task, "process_spec", None) is None or check.get("spec_sha256") != spec_hash(task.process_spec):
                return False, "Process specification missing or changed"
            ok, reason = check_process_trace(task.process_spec, data)
            if not ok:
                return False, reason
            continue
        if check_type == "lantern_people_trace":
            from benchmarks.lantern_people_trace import check_lantern_people_trace

            ok, reason = check_lantern_people_trace(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "google_oauth_demo_trace":
            from benchmarks.google_oauth_demo_check import check_google_oauth_demo_trace

            ok, reason = check_google_oauth_demo_trace(data)
            if not ok:
                return False, reason
            continue
        if check_type == "fully_cached_agent":
            usage = benchmark_state.get("usage") or {}
            if (
                int(usage.get("cache_read_input_tokens") or 0) <= 0
                or int(usage.get("cache_creation_input_tokens") or 0) != 0
                or int(usage.get("live_output_tokens") or 0) != 0
            ):
                return False, "Agent trajectory was not fully cached"
            continue
        if check_type == "plan_shape":
            plan = benchmark_state.get("plan") or find_accepted_plan(data.get("messages") or [])
            assertions = {k: v for k, v in check.items() if k != "type"}
            ok, failures = evaluate_plan_assertions(plan, assertions)
            if not ok:
                return False, "Plan shape: " + "; ".join(failures)
            continue
        if check_type == "expected_payment_receipt":
            required_when = check.get("required_when_attention_kinds")
            observed_kind = benchmark_state.get("attention_request_kind_seen")
            if isinstance(required_when, list) and required_when:
                if observed_kind not in required_when:
                    continue
            if benchmark_state.get("expected_payment_receipt_seen") is not True:
                return False, "Expected validated payment receipt was not observed"
            continue
        if check_type == "attention_kind_sequence":
            expected = check.get("value")
            observed = benchmark_state.get("expected_attention_kinds_seen")
            if observed != expected:
                return False, f"Attention sequence mismatch: expected {expected}, got {observed}"
            continue
        if check_type == "subscription_checkout_completed":
            checkout = benchmark_state.get("subscription_checkout") or {}
            if (
                checkout.get("status") != "complete"
                or checkout.get("payment_status") != "paid"
                or checkout.get("webhook_delivered") is not True
            ):
                return False, "Paid Stripe Checkout and local webhook delivery were not observed"
            continue
        if check_type == "expected_payment_lifecycle":
            if task is None:
                return False, "Payment lifecycle check requires a task contract"
            error = _validate_payment_lifecycle(task, data)
            if error:
                return False, error
            continue
        if check_type == "expected_gate":
            if task is not None and _mark_expected_gate_from_data(task, data) is True:
                benchmark_state = data.get("_benchmark", {})
                continue
            if benchmark_state.get("expected_gate_seen") is not True:
                return False, "Expected typed gate was not observed"
            continue
        if check_type == "no_browser_agent_failures":
            _, failures = _browser_agent_runtime_facts(data)
            if failures:
                return False, f"Observed browser agent failure: {failures[0]}"
            continue
        if check_type == "no_tool_failures":
            failures = _tool_runtime_failures(data)
            if failures:
                return False, f"Observed tool failure: {failures[0]}"
            continue
        if check_type == "phone_call_parked_on_hold":
            parked = phone_parked_hold_seconds(data)
            minimum = int(check.get("min_seconds", 1))
            if parked < minimum:
                return False, f"Phone call was parked by wait_for_human for {parked}s; expected at least {minimum}s"
            continue
        if check_type == "explore_research_not_reject_loop":
            loops = _explore_reject_loop_failures(data, min_rejects=int(check.get("min_rejects", 3)))
            if loops:
                return False, loops[0]
            continue
        if check_type == "explore_completion_summary":
            missing = _explore_chip_summary_failures(data, min_chars=int(check.get("min_chars", 200)))
            if missing:
                return False, missing[0]
            continue
        if check_type == "completion_summary_length":
            cards = _completion_cards_for_static_check(
                data,
                include_first_level_gps=bool(check.get("include_first_level_gps")),
            )
            if not cards:
                return False, "No finished completion summary was observed"
            minimum = int(check.get("min_chars", 1))
            forbidden = [str(item) for item in (check.get("forbidden_substrings") or []) if str(item).strip()]
            require_outputs = bool(check.get("require_outputs"))
            for card in cards:
                summary = str(card.get("summary") or "").strip()
                label = str(card.get("agent_id") or "root")[:8]
                if is_ablated_completion_summary(summary) or any(
                    marker.lower() in summary.lower() for marker in forbidden
                ):
                    return (
                        False,
                        f"T7: {label} Task Complete summary is Fast Mode-ablated",
                    )
                if len(summary) < minimum:
                    return (
                        False,
                        f"T7: {label} completion summary was {len(summary)} characters; expected at least {minimum}",
                    )
                outputs = card.get("outputs")
                if require_outputs and (not isinstance(outputs, list) or not outputs):
                    return False, f"T7: {label} Task Complete has no schema outputs"
            continue
        if check_type == "completion_structured_output_schema":
            ok, reason = _completion_structured_output_schema_check(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "completion_summary_file_outputs":
            ok, reason = _completion_summary_file_outputs_check(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "response_schema_has_file_pointer":
            ok, reason = _response_schema_has_file_pointer_check(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "completion_sms_event":
            events = benchmark_state.get("completion_sms_events") or []
            expected_count = int(check.get("expected_count", 1))
            if len(events) != expected_count:
                evidence_error = benchmark_state.get("completion_sms_evidence_error")
                suffix = f" ({evidence_error})" if evidence_error else ""
                return (
                    False,
                    f"Observed {len(events)} completion SMS events; expected exactly {expected_count}{suffix}",
                )

            agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
            root_agent_id = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
            allowed_skips = {str(reason) for reason in check.get("allow_skipped_reasons", [])}
            summaries = _final_completion_summaries(data)
            final_completion = summaries[-1] if summaries else {}
            for event in events:
                request = event.get("request") if isinstance(event.get("request"), dict) else {}
                response = event.get("response") if isinstance(event.get("response"), dict) else {}
                payload = request.get("payload") if isinstance(request.get("payload"), dict) else {}
                status_code = int(event.get("status_code") or 0)
                if request.get("event_type") != "completion":
                    return False, "Completion SMS receipt had the wrong event type"
                if not root_agent_id or request.get("agent_id") != root_agent_id:
                    return False, "Completion SMS was not emitted by the root agent"
                if not 200 <= status_code < 300 or response.get("success") is not True:
                    return False, "Completion SMS provider receipt was not successful"
                if response.get("skipped") is True and response.get("reason") not in allowed_skips:
                    return False, f"Completion SMS was unexpectedly skipped: {response.get('reason')}"
                if check.get("require_output_payload") is True and (
                    payload.get("summary") != final_completion.get("summary")
                    or payload.get("outputs") != final_completion.get("outputs")
                ):
                    return False, "Completion SMS payload did not match the final summary and outputs"
                if check.get("require_rendered_message") is True:
                    message = response.get("messagePreview")
                    if not isinstance(message, str) or not message.strip():
                        return False, "Completion SMS receipt did not include a rendered message"
                    lines = message.splitlines()
                    max_lines = int(check.get("max_lines", 8))
                    if len(lines) > max_lines:
                        return False, f"Completion SMS rendered {len(lines)} lines; expected at most {max_lines}"
                    expected_summary = " ".join(str(final_completion.get("summary") or "").split())
                    if not lines or lines[0] != f"Done: {expected_summary}":
                        return False, "Completion SMS rendered the wrong summary"
                    if not lines[-1].startswith("View agent:") or f"agent-id={root_agent_id}" not in lines[-1]:
                        return False, "Completion SMS rendered the wrong agent link"
                    outputs = final_completion.get("outputs")
                    if not isinstance(outputs, list) or not outputs:
                        return False, "Completion SMS had no structured outputs to render"
                    output_lines = lines[1:-1]
                    expected_output_count = min(len(outputs), max_lines - 2)
                    if len(output_lines) != expected_output_count:
                        return False, "Completion SMS rendered the wrong number of structured outputs"
                    for output, rendered in zip(outputs[:expected_output_count], output_lines):
                        label = str(output.get("label") or output.get("key") or "").strip()
                        rendered_label, separator, rendered_value = rendered.partition(": ")
                        if (
                            not label
                            or rendered_label.casefold() != label.casefold()
                            or separator != ": "
                            or not rendered_value
                        ):
                            return False, "Completion SMS did not render its structured output values"
            continue
        if check_type == "browser_agent_session_count":
            session_count, _ = _browser_agent_runtime_facts(data)
            minimum = int(check.get("min", 0))
            maximum = int(check.get("max", minimum))
            if not minimum <= session_count <= maximum:
                return (
                    False,
                    f"Browser agent session count was {session_count}; expected {minimum}..{maximum}",
                )
            continue
        if check_type == "agent_status":
            expected_status = str(check.get("value") or check.get("expected_status") or "COMPLETED").upper()
            observed_status = str((data.get("agent") or {}).get("status") or "UNKNOWN").upper()
            if observed_status != expected_status:
                return False, f"Agent status was {observed_status}; expected {expected_status}"
            continue
        if check_type == "approval_request_count":
            expected_count = int(check.get("value", 0))
            observed_count = int(benchmark_state.get("approvals_triggered", 0))
            if observed_count != expected_count:
                return (
                    False,
                    f"Approval request count was {observed_count}; expected exactly {expected_count}",
                )
            continue
        if check_type == "approval_request_details":
            requests = benchmark_state.get("attention_requests_seen") or []
            for request in requests:
                if _approval_request_satisfies_detail_check(request, check):
                    break
            else:
                return False, _approval_request_detail_failure(check)
            continue
        if check_type == "approval_request_details_by_kind":
            requests = benchmark_state.get("attention_requests_seen") or []
            details_by_kind = check.get("details_by_kind") or {}
            for kind, kind_check in details_by_kind.items():
                matching = [request for request in requests if _attention_request_kind(request) == kind]
                if not any(
                    _approval_request_satisfies_detail_check(
                        request,
                        kind_check,
                        user_visible_only=True,
                    )
                    for request in matching
                ):
                    return False, f"{kind}: {_approval_request_detail_failure(kind_check)}"
            continue
        if check_type == "tree_agent_status":
            expected = str(check.get("value") or "COMPLETED").upper()
            compact_tree = _compact_benchmark_state_for_judge(data).get("tree") or {}
            leftovers = []
            for agent_id, node in compact_tree.items():
                status = str(node.get("status") or "UNKNOWN").upper()
                if status != expected:
                    leftovers.append(f"{agent_id[:8]}={status}")
            if leftovers:
                return False, f"T9: leftover children {', '.join(leftovers[:8])}"
            if not compact_tree:
                return False, "T9: typed tree was empty"
            continue
        if check_type == auth_test_site.AUTH_TEST_SITE_OUTCOME_CHECK:
            ok, detail = auth_test_site.evaluate_outcome(
                check, benchmark_state.get("auth_test_site"), _root_final_answer_blob(data)
            )
            if not ok:
                return False, detail
            continue
        if check_type == "root_deliverable_markers":
            blob = _root_deliverable_blob(data)
            minimum = int(check.get("min_chars", 4000))
            if len(blob) < minimum:
                return (
                    False,
                    f"T7: deliverable blob was {len(blob)} characters; expected at least {minimum}",
                )
            lowered = blob.lower()
            missing = [marker for marker in (check.get("required_strings") or []) if str(marker).lower() not in lowered]
            if missing:
                return False, f"T7: deliverable missing required marker {missing[0]!r}"
            creator_names = [str(name) for name in (check.get("creator_names") or []) if str(name).strip()]
            min_creators = int(check.get("min_creator_names") or 0)
            if creator_names and min_creators:
                found = [name for name in creator_names if name.lower() in lowered]
                if len(found) < min_creators:
                    return (
                        False,
                        f"T7: deliverable named {len(found)} July creators; expected >= {min_creators}",
                    )
            continue
        if check_type == "first_level_gp_count":
            gps = _first_level_gps_from_data(data)
            minimum = int(check.get("min", 50))
            real = [gp for gp in gps if gp.get("has_real_transcript")]
            if len(real) < minimum:
                return (
                    False,
                    f"T2: {len(real)} first-level GPs with real transcripts "
                    f"(of {len(gps)} first-level GPs); expected >= {minimum}",
                )
            continue
        if check_type == "first_level_gp_explore_research":
            gps = _first_level_gps_from_data(data)
            if not gps:
                return False, "T3: first_level_gps was empty"
            failures = []
            for gp in gps:
                explore = int(gp.get("explore_spawn_count") or 0)
                research = int(gp.get("research_tool_count") or 0)
                stub = bool(gp.get("has_traj_end_stub"))
                if stub or (explore < 1 and research < 3):
                    failures.append(gp)
            if failures:
                sample = failures[0]
                return (
                    False,
                    "T3: first-level GP "
                    f"{str(sample.get('agent_id') or '')[:8]} missing explore/research "
                    f"(explore={int(sample.get('explore_spawn_count') or 0)}, "
                    f"research={int(sample.get('research_tool_count') or 0)}, "
                    f"stub={bool(sample.get('has_traj_end_stub'))}; "
                    f"{len(failures)}/{len(gps)} failing)",
                )
            continue
        if check_type == "explore_spawn_count":
            compact_tree = _compact_benchmark_state_for_judge(data).get("tree") or {}
            minimum = int(check.get("min", 1))
            total = sum(
                int(node.get("explore_spawn_count") or 0) for node in compact_tree.values() if isinstance(node, dict)
            )
            if total < minimum:
                return False, f"Tree spawned {total} explore agent(s); expected at least {minimum}"
            continue
        if check_type == "general_purpose_explore_spawn_limit":
            compact_tree = _compact_benchmark_state_for_judge(data).get("tree") or {}
            maximum = int(check.get("max", 3))
            gps = [
                node
                for node in compact_tree.values()
                if isinstance(node, dict)
                and (
                    node.get("agent_type") == "general_purpose"
                    or str(node.get("goal") or "").startswith("You are analyzing ONE creator")
                )
            ]
            if not gps:
                return False, "T3: general-purpose agent tree was empty"
            over_limit = [gp for gp in gps if int(gp.get("explore_spawn_count") or 0) > maximum]
            if over_limit:
                sample = over_limit[0]
                return (
                    False,
                    "T3: general-purpose agent "
                    f"{str(sample.get('agent_id') or '')[:8]} spawned "
                    f"{int(sample.get('explore_spawn_count') or 0)} explore agents; "
                    f"maximum is {maximum} per general-purpose agent "
                    f"({len(over_limit)}/{len(gps)} over limit)",
                )
            continue
        if check_type == "first_level_gp_july_trajectories":
            gps = _first_level_gps_from_data(data)
            if not gps:
                return False, "T4: first_level_gps was empty"
            failures = []
            for gp in gps:
                messages = int(gp.get("message_count") or 0)
                explore = int(gp.get("explore_spawn_count") or 0)
                research = int(gp.get("research_tool_count") or 0)
                stub = bool(gp.get("has_traj_end_stub"))
                ok = (messages >= 12 or research >= 3 or explore >= 1) and not stub
                if not ok:
                    failures.append(gp)
            if failures:
                sample = failures[0]
                return (
                    False,
                    "T4: first-level GP "
                    f"{str(sample.get('agent_id') or '')[:8]} below July trajectory bar "
                    f"(messages={int(sample.get('message_count') or 0)}, "
                    f"research={int(sample.get('research_tool_count') or 0)}, "
                    f"explore={int(sample.get('explore_spawn_count') or 0)}, "
                    f"stub={bool(sample.get('has_traj_end_stub'))}; "
                    f"{len(failures)}/{len(gps)} failing)",
                )
            continue
        if check_type == "zero_live_spend":
            compact = _compact_benchmark_state_for_judge(data)
            usage = compact.get("usage") if isinstance(compact.get("usage"), dict) else {}
            cost = int(usage.get("cost_cents") or 0)
            cache_create = int(usage.get("cache_creation_input_tokens") or 0)
            live_out = int(usage.get("live_output_tokens") or 0)
            if cost != 0 or cache_create != 0 or live_out != 0:
                return (
                    False,
                    "T5: live spend not zero "
                    f"(cost_cents={cost}, cache_creation_input_tokens={cache_create}, "
                    f"live_output_tokens={live_out})",
                )
            gps = list(compact.get("first_level_gps") or [])
            stubs = [gp for gp in gps if isinstance(gp, dict) and gp.get("has_traj_end_stub")]
            if stubs:
                return (
                    False,
                    f"T5: {len(stubs)} first-level GP traj-end stubs while claiming $0 live spend",
                )
            continue
        if check_type == "no_nested_general_purpose":
            compact_tree = _compact_benchmark_state_for_judge(data).get("tree") or {}
            violations = _nested_general_purpose_violations(compact_tree)
            if violations:
                sample = violations[0]
                return (
                    False,
                    "T6: nested general-purpose "
                    f"{str(sample.get('agent_id') or '')[:8]} under "
                    f"{str(sample.get('parent_agent_type') or 'unknown')} "
                    f"{str(sample.get('parent_agent_id') or '')[:8]} "
                    f"({len(violations)} total)",
                )
            if not compact_tree:
                return False, "T6: typed tree was empty"
            continue
        if check_type == "no_synthetic_agent_skip_messages":
            failures = _synthetic_agent_skip_failures(data)
            if failures:
                return False, f"T6: visible synthetic agent completion: {failures[0]}"
            continue
        if check_type == "agent_task_title":
            ok, reason = _agent_task_title_check(data, check)
            if not ok:
                return False, reason
            continue
        if check_type == "principal_user_andy":
            ok, reason = _principal_user_andy_check(data)
            if not ok:
                return False, reason
            continue
        if check_type == "approval_request_details_for_seen_kind":
            observed_kind = benchmark_state.get("attention_request_kind_seen")
            details_by_kind = check.get("details_by_kind") or {}
            if not isinstance(observed_kind, str) or not observed_kind:
                return False, "No observed attention kind for detail check"
            if observed_kind not in details_by_kind:
                return (
                    False,
                    f"Observed attention kind {observed_kind} has no declared detail contract",
                )
            kind_check = details_by_kind[observed_kind]
            if not isinstance(kind_check, dict):
                return False, f"{observed_kind}: detail contract must be an object"
            requests = benchmark_state.get("attention_requests_seen") or []

            def _request_kind(request: dict) -> str:
                stored = request.get("kind")
                if isinstance(stored, str) and stored.strip():
                    return stored
                return _attention_request_kind(request)

            matching = [request for request in requests if _request_kind(request) == observed_kind]
            if not any(
                _approval_request_satisfies_detail_check(
                    request,
                    kind_check,
                    user_visible_only=True,
                )
                for request in matching
            ):
                return False, f"{observed_kind}: {_approval_request_detail_failure(kind_check)}"
            continue
        if check_type == "code_bench_hidden_tests":
            from benchmarks.code_bench import static_check as code_bench_static_check

            ok, reason = code_bench_static_check(data, check)
            if not ok:
                return False, reason
            continue
        if check_type in display_check.DISPLAY_CHECK_TYPES:
            if check_type == "display_media_shown":
                ok, reason = display_check.check_display_media_shown(data, check)
            elif check_type == "display_artifact_figures":
                ok, reason = display_check.check_display_artifact_figures(data, check)
            else:
                ok, reason = display_check.check_final_answer_figures(_root_final_answer_blob(data), check)
            if not ok:
                return False, reason
            continue
        if check_type == "claude_code_session_output":
            sessions = benchmark_state.get("claude_code_sessions") or []
            min_sessions = int(check.get("min_sessions", 1))
            min_chars = int(check.get("min_chars", 1))
            if len(sessions) < min_sessions:
                evidence_error = benchmark_state.get("claude_code_session_evidence_error")
                suffix = f" ({evidence_error})" if evidence_error else ""
                return (
                    False,
                    f"Claude Code session count was {len(sessions)}; expected at least {min_sessions}{suffix}",
                )
            stored = [
                session
                for session in sessions
                if isinstance(session, dict)
                and isinstance(session.get("output"), str)
                and len(session.get("output", "").strip()) >= min_chars
            ]
            if len(stored) < min_sessions:
                return (
                    False,
                    f"Claude Code sessions with stored transcripts (≥{min_chars} chars): "
                    f"{len(stored)}; expected at least {min_sessions}",
                )
            continue
        return False, f"Unsupported enforced static check: {check_type}"
    return True, "All declared static checks passed"


async def _run_declared_evaluators(
    task: BenchmarkTask,
    data: dict,
    *,
    base_url: str | None = None,
    static_only: bool = False,
) -> tuple[bool, Optional[str], list[dict]]:
    """Run required catalog evaluators; unsupported/erroring evaluators fail closed."""
    if getattr(task, "process_spec", None) is not None or "process" in getattr(task, "tags", []):
        from benchmarks.process_bench import validate_task_process

        validate_task_process(vars(task))
    if not task.enforce_declared_evaluators:
        return True, None, []

    if any(
        check.get("type") == "completion_sms_event"
        for evaluator in task.evaluators
        if evaluator.get("method") == "static_check"
        for check in evaluator.get("checks", [])
    ):
        await _hydrate_completion_sms_events(data)

    if _task_declares_static_check(task, auth_test_site.AUTH_TEST_SITE_OUTCOME_CHECK):
        await _hydrate_auth_test_site_evidence(data, base_url, task=task)

    if task.name.startswith("code-bench-"):
        await _hydrate_code_bench_results(task, data)

    from benchmarks.semantic_evaluator_evidence import messages_have_code_agent_grounding

    _needs_cc_hydrate = any(
        check.get("type") == "claude_code_session_output"
        for evaluator in task.evaluators
        if evaluator.get("method") == "static_check"
        for check in evaluator.get("checks", [])
    ) or (
        any(evaluator.get("method") == "single_turn_llm_judge" for evaluator in task.evaluators)
        and messages_have_code_agent_grounding(data)
    )
    if _needs_cc_hydrate:
        await _hydrate_claude_code_sessions(data)

    needs_tree_evidence = any(
        evaluator.get("method") in {"single_turn_llm_judge", "agentic_llm_judge", "polar"}
        for evaluator in task.evaluators
    )
    if needs_tree_evidence and base_url:
        await _hydrate_semantic_evaluator_tree(data, base_url)

    if base_url and any(
        _task_declares_static_check(task, check_type)
        for check_type in ("display_media_shown", "display_artifact_figures")
    ):
        await _hydrate_display_artifacts(data, base_url)

    # Judge-visible routing trace (compact state keeps every `_benchmark` key).
    routing_markers = sorted(
        {
            str(check.get("marker"))
            for evaluator in task.evaluators
            if evaluator.get("method") == "static_check"
            for check in evaluator.get("checks", [])
            if check.get("type") in TREE_ROUTING_CHECK_TYPES and check.get("marker")
        }
    )
    if routing_markers:
        data.setdefault("_benchmark", {})["tree_feedback_routing"] = [
            routing_trace(data, marker) for marker in routing_markers
        ]
    background_types = sorted(
        {
            str(check.get("agent_type"))
            for evaluator in task.evaluators
            if evaluator.get("method") == "static_check"
            for check in evaluator.get("checks", [])
            if check.get("type") == "background_task_message_routed" and check.get("agent_type")
        }
    )
    if background_types:
        data.setdefault("_benchmark", {})["background_task_routing"] = [
            background_routing_trace(data, agent_type) for agent_type in background_types
        ]

    results: list[dict] = []
    for evaluator in task.evaluators:
        evaluator_id = evaluator.get("id", "unnamed")
        method = evaluator.get("method")
        if static_only and method != "static_check":
            continue
        usage = None
        evidence_mode = method
        try:
            if method == "static_check":
                passed, reasoning = _run_declared_static_check(task, evaluator, data)
                score = 1.0 if passed else 0.0
            elif method == "single_turn_llm_judge":
                if getattr(task, "process_spec", None) is not None:
                    from benchmarks.process_bench import process_evidence

                    evidence = process_evidence(data)
                else:
                    evidence = _declared_evaluator_evidence(data)
                judged = await _call_declared_llm_judge(task, evaluator, data, evidence=evidence)
                evidence_mode = judged.get("evidence_mode", method)
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "Judge returned no reasoning")
                usage = judged.get("usage")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            elif method == "agentic_llm_judge":
                judged = await _call_declared_agentic_llm_judge(task, evaluator, data)
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "Judge returned no reasoning")
                usage = judged.get("usage")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            elif method == "code_bench_screenshot_judge":
                # Rendered-page judge for code-bench front-end fixtures (benchmarks/code_bench.py).
                from benchmarks.code_bench import run_screenshot_judge

                judged = await run_screenshot_judge(evaluator, data)
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "screenshot judge returned no reasoning")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            elif method == "polar":
                # Isolated Odysseys-faithful path — see benchmarks/polar_evaluator.py.
                # Does not share prompts/evidence builders with other judge methods.
                from benchmarks.polar_evaluator import run_polar_evaluator

                judged = await run_polar_evaluator(
                    task_prompt=task.prompt,
                    evaluator=evaluator,
                    data=data,
                )
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "polar judge returned no reasoning")
                usage = judged.get("usage")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            else:
                raise ValueError(f"Unsupported enforced evaluator method: {method}")
        except Exception as exc:
            error_type = ComputeTokenUnavailable if isinstance(exc, ComputeTokenUnavailable) else RuntimeError
            raise error_type(f"Declared evaluator {evaluator_id} execution failed: {exc}") from exc
        result = {
            "id": evaluator_id,
            "method": method,
            "score": score,
            "passed": passed,
            "reasoning": reasoning,
        }
        if evidence_mode != method:
            result["evidence_mode"] = evidence_mode
        if usage is not None:
            result["usage"] = usage
        judge_audit = (locals().get("judged") or {}).get("judge_audit") if method != "static_check" else None
        if judge_audit:
            result["judge_audit"] = judge_audit
        if method == "polar":
            # Surface per-rubric detail for hub / run JSON without affecting other methods.
            polar_results = locals().get("judged")
            if isinstance(polar_results, dict) and polar_results.get("rubric_results") is not None:
                result["rubric_results"] = polar_results["rubric_results"]
                result["perfect"] = polar_results.get("perfect")
                result["num_screenshots_sent"] = polar_results.get("num_screenshots_sent")
        results.append(result)
        if not passed:
            return False, f"Declared evaluator {evaluator_id} failed: {reasoning}", results
    return True, None, results


async def run_single_task(
    base_url: str,
    task: BenchmarkTask,
    keep_failed_agents: bool = False,
    checkpoint_source_index: int | None = None,
    checkpoint_source_boundary: str = "message-index",
    checkpoint_source_out: Path | None = None,
    checkpoint_tree_out: Path | None = None,
    on_agent_created: Optional[Callable[[str, str], None]] = None,
    on_task_evaluated: Optional[Callable[[TaskResult], None | Awaitable[None]]] = None,
    other_task_roots: Callable[[], set[str]] | None = None,
) -> TaskResult:
    """Run a single benchmark task. Returns TaskResult."""
    _validate_task_target(task, base_url)
    # Repeated catalog selections share a template. Keep native lifecycle
    # ownership on this execution while preserving caller configuration/provenance.
    task = copy.copy(task)
    task._wmh_seeded_session_id = None
    task._wmh_owned_session = None
    task._wmh_retirement_receipt = None
    task._wmh_retirement_operation = None
    task._wmh_retirement_error = None
    task._wmh_agent_admission = None
    # The SMS supervisor is not a Temporal agent — it is an in-backend tool loop
    # woken by an inbound text. It gets its own driver; everything around this
    # call (selection, concurrency, history, run records) is unchanged.
    if task.runner == "sms":
        from benchmarks.sms_runner import build_deps_from_module, run_sms_task

        if resolve_live_fixtures(getattr(task, "environment", None)):
            with _benchmark_run_user_scope(_run_user_id_override_for_task(task, base_url)):
                manifests = await _apply_live_fixtures(task, base_url)
                try:
                    return await run_sms_task(base_url, task, build_deps_from_module(sys.modules[__name__], other_task_roots, on_agent_created, task.name))
                finally:
                    await _restore_live_fixture_scenarios_async(manifests)
        return await run_sms_task(base_url, task, build_deps_from_module(sys.modules[__name__], other_task_roots, on_agent_created, task.name))
    if _effective_harness(task) == "codex":
        if not await _check_codex_harness_credentials(base_url):
            print(f"  ⚠ Codex harness credentials unavailable at task dispatch — skipping: {task.name}")
            return _codex_harness_credential_skip_result(task)
    # Parallel suites can queue a long-running Claude task for several minutes.
    # A credential that was available during the suite-level preflight may be
    # invalidated or enter cooldown before this task obtains its execution slot.
    # Re-check at dispatch so credential loss produces the deploy-approved skip
    # instead of an agent recursively retrying an impossible code session.
    if task.requires_claude_code and not await _check_claude_code_credentials(base_url):
        if os.environ.get("BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP", "").strip() != "1":
            raise RuntimeError(f"Claude Code credentials unavailable at task dispatch: {task.name}")
        print(f"  ⚠ Claude Code credentials unavailable at task dispatch — skipping: {task.name}")
        return _claude_code_credential_skip_result(task)
    custody = {"task_name": task.name, "roots": [], "callback": on_agent_created, "graded_creation": "not_started"}
    token = _task_root_custody.set(custody)
    async def evaluated_with_custody(result):
        _bind_task_root_custody(result, custody)
        if on_task_evaluated:
            value = on_task_evaluated(result)
            if inspect.isawaitable(value):
                await value
    try:
        with _benchmark_run_user_scope(_run_user_id_override_for_task(task, base_url)):
            try:
                result = await _run_single_task_as_run_user(
                    base_url,
                    task,
                    keep_failed_agents,
                    checkpoint_source_index,
                    checkpoint_source_boundary,
                    checkpoint_source_out,
                    checkpoint_tree_out,
                    on_agent_created,
                    evaluated_with_custody,
                )
            finally:
                # An already reported failed join must not replace its original
                # execution error or abandon the independently owned cleanup path.
                if getattr(task, "_wmh_retirement_error", None) is None:
                    await _retire_owned_native_world(task)
        return _bind_task_root_custody(result, custody)
    finally:
        _task_root_custody.reset(token)


def _run_user_id_override_for_task(task: BenchmarkTask, base_url: str) -> Optional[str]:
    # Includes the non-admin payment identities: the admin funding path mints a company-funded card
    # with no personal Stripe hold, which the lifecycle tasks explicitly assert.
    # `_benchmark_user_id_for_task` is base-URL aware (it declines to redirect a sandbox payment
    # task pointed at a remote stack, where the synthetic fixture user does not exist) and honors
    # the harness env override; `benchmark_run_user_id_for_task` supplies the production lifecycle
    # identity, which only exists there.
    run_user_id_override = _benchmark_user_id_for_task(task.name, base_url)
    if run_user_id_override is None and task.name in AGENT_PAYMENT_PRODUCTION_LIFECYCLE_TASK_NAMES:
        run_user_id_override = benchmark_run_user_id_for_task(task.name)
    if run_user_id_override is None:
        # An identity live-fixture both seeds a production person into the
        # isolated DB and declares who the task runs as. Deriving the run user
        # from the declared fixture keeps the two in lockstep: seeding her rows
        # but still running as the dev user would exercise the wrong account,
        # and running as her without the fixture is the FK crash this fixture
        # exists to prevent.
        run_user_id_override = _live_fixture_run_user_id(task)
    return run_user_id_override


async def _warm_cache_gated_root(base_url: str, task: BenchmarkTask) -> Optional[dict]:
    """Prime the root's static prompt prefix for a cache-gated task (benchmarks.cache_warmup).

    Recorded on the result only; the measured prompt-cache share never includes it.
    """
    if PER_TASK_CACHE_HIT_RATCHET.get(task.name, 0) <= 0:
        return None
    from benchmarks.cache_warmup import warm_root_static_prefix

    user_id = _current_benchmark_user_id()
    model_override = (os.environ.get("BENCHMARK_MODEL") or "").strip()
    model = model_override if model_override and task.demo_cache != "on" else task.model
    warmup = await warm_root_static_prefix(
        base_url=base_url,
        headers={"X-API-Key": API_KEY or "", "X-User-Id": user_id},
        user_id=user_id,
        goal=_benchmark_goal_for_task(task, base_url),
        start_phase=task.start_phase,
        model=model or None,
    )
    print(f"    🔥 prompt-cache warmup for {task.name}: {json.dumps(warmup, sort_keys=True)[:400]}")
    return warmup


async def _run_single_task_as_run_user(
    base_url: str,
    task: BenchmarkTask,
    keep_failed_agents: bool,
    checkpoint_source_index: int | None,
    checkpoint_source_boundary: str,
    checkpoint_source_out: Path | None,
    checkpoint_tree_out: Path | None,
    on_agent_created: Optional[Callable[[str, str], None]],
    on_task_evaluated: Optional[Callable[[TaskResult], None | Awaitable[None]]] = None,
) -> TaskResult:
    if task.name in AGENT_PAYMENT_PRODUCTION_LIFECYCLE_TASK_NAMES and not _is_local_base_url(base_url):
        await _preflight_production_payment_identity(base_url)
    if getattr(task, "disable_purchase_reuse", False):
        if _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} disable_purchase_reuse requires a remote/production backend")
        await _preflight_close_purchase_reuse_gate(base_url)

    if task.name in MINTED_AGENT_ACCOUNT_TASK_NAMES:
        result = await run_minted_agent_account_task(
            base_url,
            task,
            keep_failed_agents,
            on_agent_created=on_agent_created,
        )
        # Composite tasks return a single evaluator record for multiple exact
        # roots. Bind that record to the same execution mode as ordinary task
        # records so cloud artifact identity checks can accept its real result.
        result.world_model_mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real")
        return result

    if task.name == AMAZON_AUTH_ASSISTANCE_TASK_NAME and _force_show_passwords_mode() and _is_local_base_url(base_url):
        auth_realm = os.environ.get("BENCHMARK_BROWSER_AUTH_REALM") or "amazon.com"
        disabled_count = _disable_local_steel_and_cookie_auth_for_realm(USER_ID, auth_realm)
        fixture = _seed_local_bad_amazon_auth_scenario(USER_ID, auth_realm)
        print(
            f"    🔐 Force-show-passwords fixture: disabled {disabled_count} Steel/Cookie auth row(s), "
            f"seeded CookieBundle {fixture['cookie_bundle_id'][:8]} and "
            f"{len(fixture['password_ids'])} bad password row(s)"
        )

    grep_fixture_manifest: Optional[dict] = None
    plaid_transactions_manifest: Optional[dict] = None
    plaid_transactions_fixture_action: Optional[str] = None
    free_credit_subscription_manifest: Optional[dict] = None
    gate_fixture_manifest: Optional[dict] = None
    new_user_payment_tasks = {NEW_USER_PAYMENT_JOURNEY_TASK_NAME, ROSE_SHOP_NO_SUBSCRIPTION_TASK_NAME}
    if task.name in {FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME} | new_user_payment_tasks:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        if task.name == ROSE_SHOP_NO_SUBSCRIPTION_TASK_NAME:
            fixture_user_id = _current_benchmark_user_id()
        elif task.name == NEW_USER_PAYMENT_JOURNEY_TASK_NAME:
            fixture_user_id = _new_user_payment_journey_user_id()
        else:
            fixture_user_id = _free_credit_subscription_gate_user_id()
        free_credit_subscription_manifest = _run_free_credit_subscription_fixture("apply", fixture_user_id)
        print(
            "    💳 Prepared free-credit subscription gate fixture: "
            f"user={free_credit_subscription_manifest.get('user_id')} "
            f"credit={free_credit_subscription_manifest.get('credit_cents')}c "
            f"used={free_credit_subscription_manifest.get('used_cents')}c"
        )
        if task.name in new_user_payment_tasks:
            _run_new_user_payment_fixture(fixture_user_id)
            await _verify_new_user_payment_start_state(base_url, fixture_user_id)
    if task.name in GATE_FIXTURE_TASK_MODES:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        gate_fixture_manifest = _run_gate_fixture(task.name, "apply")
        print(
            "    🚧 Prepared gate fixture: "
            f"mode={gate_fixture_manifest.get('fixture_mode')} "
            f"user={gate_fixture_manifest.get('user_id')}"
        )
        if task.name == SUBSCRIPTION_WEBHOOK_RESUME_TASK_NAME:
            webhook_fixture_manifest = _run_subscription_webhook_resume_fixture(task.name)
            print(
                "    💳 Prepared subscription-webhook billing fixture: "
                f"user={webhook_fixture_manifest.get('user_id')} "
                f"stripe_customer={str(webhook_fixture_manifest.get('stripe_customer_id', ''))[:12]}"
            )
    if task.name == GREP_EXPLORE_STRESS_TASK_NAME:
        if not _is_local_base_url(base_url):
            raise RuntimeError("grep-explore-stress must run against the local benchmark stack")
        _restore_grep_frozen_base_snapshot()
        grep_fixture_manifest = _run_grep_fixture("apply")
        print("    🔎 Applied deterministic grep benchmark overlay")
    if task.name in PLAID_TRANSACTION_BENCHMARK_TASK_NAMES:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        action = _plaid_transactions_fixture_action()
        plaid_transactions_fixture_action = action
        plaid_transactions_manifest = _run_plaid_transactions_fixture(action)
        mode = plaid_transactions_manifest.get("fixture_mode", action)
        tx_count = plaid_transactions_manifest.get("transaction_count", "?")
        print(f"    💳 Prepared Plaid transaction fixture mode={mode} transactions={tx_count}")
    if task.name == USER_DATA_PROD_GREP_TASK_NAME:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        user_data_manifest = _run_user_data_fixture("apply")
        doc_count = user_data_manifest.get("document_count", "?")
        provider_count = user_data_manifest.get("provider_count", "?")
        print(f"    📄 Seeded frozen user-data fixture: {doc_count} documents across {provider_count} providers")
    if task.name in GOOGLE_WORKSPACE_BENCHMARK_TASK_NAMES:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        google_workspace_manifest = _run_google_workspace_fixture("apply")
        print(
            "    📅 Seeded frozen Google Calendar and Drive fixture: "
            f"{google_workspace_manifest.get('event_count', '?')} events, "
            f"{google_workspace_manifest.get('file_count', '?')} files"
        )
    if task.name == DOORDASH_FOOD_PLAN_TASK_NAME:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        doordash_manifest = _run_doordash_food_plan_fixture("apply")
        prompt_chars = doordash_manifest.get("execute_prompt_chars", doordash_manifest.get("benchmark_goal_chars", "?"))
        print(f"    🛒 Applied DoorDash food-plan prod fixture (execute_prompt_chars={prompt_chars})")

    phone_callee: Optional[PhoneCalleeSession] = None
    if task.phone_persona:
        phone_callee = PhoneCalleeSession(task.name, task.phone_persona)
        await phone_callee.setup()
        task._callee_phone_number = phone_callee.dial_number
        hold_note = f" via hold line {phone_callee.dial_number}" if phone_callee.hold_line else ""
        print(
            f"    📞 Benchmark callee ready: {phone_callee.phone_number}{hold_note} "
            f"(persona assistant {phone_callee.assistant_id[:8]})"
        )

    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)
    step_budget = polar_browser_step_budget(task)
    print(f"\n  {'=' * 50}")
    print(f"  📋 {task.name}: {task.title}")
    if polar_wall_clock_disabled(task) or resolved_timeout in (None, 0):
        budget_note = f", browser_steps≤{step_budget}" if step_budget else ""
        print(f"     timeout=disabled (step budget){budget_note}, price_limit={task.effective_price_limit_cents()}c")
    else:
        print(f"     timeout={resolved_timeout}s, price_limit={task.effective_price_limit_cents()}c")
    all_attachments = task.attachments or ([task.attachment] if task.attachment else [])
    if all_attachments:
        print(f"     attachments={all_attachments}")
    if task.approval_handling:
        print(f"     approval={task.approval_handling}")
    print(f"  {'=' * 50}")

    previous_active_task_name = os.environ.get("BENCHMARK_ACTIVE_TASK_NAME")
    previous_active_task_block_dom_patch = os.environ.get("BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH")
    previous_disable_saved_browser_auth = os.environ.get("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH")
    os.environ["BENCHMARK_ACTIVE_TASK_NAME"] = task.name
    if getattr(task, "success_on_payment_card_request", False):
        os.environ["BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH"] = "1"
    else:
        os.environ.pop("BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH", None)
    if should_disable_saved_browser_auth(task):
        os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = "true"
        print("    🍪 Guest-checkout task: disabled saved browser auth material")

    start = time.time()
    start_time = datetime.now(timezone.utc)
    agent_id = ""
    data: dict = {}
    last_snapshot: dict = {}
    archive_manifest_ref: Optional[str] = None
    world_model_fidelity: Optional[dict] = None
    realtime_monitor: Optional[SupabaseRealtimeSmokeMonitor] = None
    realtime_tree_task: Optional[asyncio.Task] = None
    realtime_tree_stop = asyncio.Event()
    live_fixture_manifests: list[dict] = []
    auth_test_site_manifest: Optional[dict] = None
    interrupt_cleanup_started = False
    interrupt_cleanup_ready = False
    evaluated_failure_reason: Optional[str] = None

    temp_csv_paths: list = []  # track temp files for cleanup

    async def start_realtime_capture() -> None:
        nonlocal realtime_tree_task
        if not agent_id:
            return
        try:
            status = await subscribe_supabase_realtime_agent(agent_id)
        except Exception as exc:
            status = f"[supabase-realtime] capture disabled for agent:{agent_id[:12]} ({exc})"
        print(f"    🔌 Realtime capture {status}")

        async def discover_tree_agents() -> None:
            seen = {agent_id}
            while not realtime_tree_stop.is_set():
                try:
                    for agent_info in await get_agent_tree(base_url, agent_id):
                        if realtime_tree_stop.is_set():
                            break
                        aid = agent_info.get("agent_id")
                        if aid and aid not in seen:
                            seen.add(aid)
                            await subscribe_supabase_realtime_agent(aid)
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(realtime_tree_stop.wait(), timeout=2)
                except TimeoutError:
                    pass

        realtime_tree_task = asyncio.create_task(discover_tree_agents(), name=f"realtime-capture-{agent_id[:8]}")

    async def start_realtime_monitor() -> None:
        nonlocal realtime_monitor
        if "smoke" not in task.tags:
            return
        is_private = "localhost" not in base_url and "127.0.0.1" not in base_url
        if is_private:
            print(f"    ⚠ Realtime monitor disabled for prod agent:{agent_id[:12]} (private channels require JWT auth)")
            return
        realtime_monitor = SupabaseRealtimeSmokeMonitor(agent_id, private=is_private)
        try:
            await realtime_monitor.start()
        except Exception as exc:
            print(f"    ⚠ Realtime monitor disabled for agent:{agent_id[:12]} ({exc})")
            realtime_monitor = None
            return
        print(f"    🔌 Realtime monitor subscribed to agent:{agent_id[:12]}")

    try:
        await prepare_sandbox_payment_residual(task, base_url)
        setup_fixture_action = _agentcard_setup_fixture_action(task, base_url)
        if setup_fixture_action == "reset":
            await configure_benchmark_agentcard_setup(base_url, "reset")
            print("    🔐 Reset AgentCard setup fixture to connect_required")
        elif setup_fixture_action == "complete":
            await configure_benchmark_agentcard_setup(base_url, "complete")
            print("    🔐 Seeded connected AgentCard sandbox fixture")

        if task.name == MESSAGE_PERSON_TASK_NAME:
            await _preflight_message_person_bridge(base_url)
        if task.name == MESSAGE_PERSON_AGENT_SMS_TASK_NAME and ("localhost" in base_url or "127.0.0.1" in base_url):
            seeded_email = _prepare_local_agent_sms_sender(USER_ID)
            if seeded_email:
                print(f"    🧪 Seeded AgentPhone sender for live bench: {seeded_email}")
        # Apply the live overlay inside the cleanup boundary. The passkey-only
        # scenario intentionally removes shared browser state and must restore it
        # even when agent creation or evaluation fails.
        live_fixture_manifests = await _apply_live_fixtures(task, base_url)
        memory_fixture_manifests = await _apply_memory_fixtures(task, base_url)
        if memory_fixture_manifests:
            live_fixture_manifests.append({"kind": "memory", "fixtures": memory_fixture_manifests})
        auth_test_site_manifest = await _apply_auth_test_site(task, base_url)
        if task.browser_profile_mode == "fresh" and not _is_simulate_mode():
            if not _is_local_base_url(base_url):
                raise RuntimeError(f"{task.name}: fresh browser state requires an isolated local benchmark stack")
            live_fixture_manifests.append(
                _apply_fresh_browser_state_scenario(
                    LiveFixtureContext(
                        base_url=base_url,
                        user_id=_current_benchmark_user_id(),
                        auth_realm=str(task.browser_auth_realm),
                    )
                )
            )

        if _effective_harness(task) == "codex":
            from benchmarks.codex_runner import build_deps_from_module, run_codex_task

            fast_mode_cache = _resolved_fast_mode_cache(task)
            benchmark_goal = _benchmark_goal_for_task(task, base_url)
            return await run_codex_task(
                base_url,
                task,
                build_deps_from_module(sys.modules[__name__]),
                benchmark_goal,
                fast_mode_cache_enabled=fast_mode_cache,
            )

        custody = _task_root_custody.get()
        if custody is not None:
            custody["graded_creation"] = "unknown"
        prompt_cache_warmup = await _warm_cache_gated_root(base_url, task)
        agent_id = await create_agent(base_url, task)
        _register_task_root(task.name, agent_id, "graded")
        execution_started_at = asyncio.get_running_loop().time()
        kill_fixture = None
        if task.name == "kill-agent-subtree":
            from benchmarks.kill_agent_fixture import prepare
            kill_fixture = await prepare(base_url, agent_id, _current_benchmark_user_id(), API_KEY,
                                         _local_benchmark_task_queue(base_url))

        async def execute_agent(snapshot: dict):
            nonlocal grep_fixture_manifest, last_snapshot
            last_snapshot = snapshot
            if on_agent_created and _task_root_custody.get() is None:
                on_agent_created(task.name, agent_id)
            print(f"    Agent created: {agent_id[:12]}...")
            if not all_attachments and task.name == GREP_EXPLORE_STRESS_TASK_NAME:
                grep_fixture_manifest = _run_grep_fixture("apply-agent-network", agent_id)
                print("    🔎 Attached seeded agent_network branch")
            await start_realtime_capture()
            await start_realtime_monitor()
            if all_attachments:
                file_pointers = []
                for attach_filename in all_attachments:
                    filepath = _resolve_task_attachment_path(attach_filename, temp_csv_paths)
                    if not os.path.exists(filepath):
                        raise FileNotFoundError(f"Test asset not found: {filepath}")

                    # Slice CSV if row_start/row_end are set
                    if filepath.endswith(".csv") and task.row_start is not None and task.row_end is not None:
                        filepath = slice_csv(filepath, task.row_start, task.row_end)
                        temp_csv_paths.append(filepath)

                    print(f"    Uploading {attach_filename}...")
                    fp = await upload_attachment(base_url, agent_id, filepath)
                    file_pointers.append(fp)
                    print("    ✅ Uploaded, FilePointer received")

                # Post a message with all file pointers so the agent can see them
                if file_pointers:
                    await post_attachment_message(base_url, agent_id, file_pointers)
                    print(f"    📎 Posted {len(file_pointers)} file(s) as agent message")
            await post_world_model_update_events(base_url, agent_id)

            async def observe_agent():
                if checkpoint_source_index is not None:
                    if checkpoint_source_out is None:
                        raise ValueError("checkpoint_source_out is required in checkpoint source mode")
                    data = await poll_agent_until_message_index(
                        base_url,
                        agent_id,
                        task,
                        checkpoint_source_index,
                        checkpoint_source_boundary,
                    )
                    messages = data.get("messages", []) or []
                    export_checkpoint_source_from_local_db(
                        agent_id,
                        source_out=checkpoint_source_out,
                        tree_out=checkpoint_tree_out,
                    )
                    duration = time.time() - start
                    return TaskResult(
                        name=task.name,
                        passed=True,
                        agent_id=agent_id,
                        status=(data.get("agent") or {}).get("status", "PAUSED"),
                        benchmark_status="PASSED",
                        progress_score=(data.get("agent") or {}).get("progress", 0),
                        duration_seconds=round(duration, 1),
                        cost_cents=0,
                        message_count=len(messages),
                        failure_reason=None,
                    )

                return await _poll_agent(base_url, agent_id, task, realtime_monitor, snapshot)

            # Archival is required, but must not hide a short-lived feedback trigger.
            archive = asyncio.create_task(archive_agent_start(base_url, agent_id))
            observation = asyncio.create_task(observe_agent())
            try:
                start_fixture_ref, result = await asyncio.gather(archive, observation)
            finally:
                for pending in (archive, observation):
                    if not pending.done():
                        pending.cancel()
                await asyncio.gather(archive, observation, return_exceptions=True)
            if start_fixture_ref:
                print(f"    🧊 Trace archive start fixture: {start_fixture_ref}")
            return result

        try:
            execution_result = await _run_with_agent_execution_backstop(
                base_url, agent_id, execute_agent, started_at=execution_started_at, task=task
            )
        except BaseException:
            if kill_fixture is not None:
                from benchmarks.kill_agent_fixture import retire_fixture
                await retire_fixture(base_url, API_KEY, kill_fixture)
            raise
        kill_evidence = None
        if kill_fixture is not None:
            from benchmarks.kill_agent_fixture import verify_and_cleanup
            kill_evidence = await verify_and_cleanup(base_url, API_KEY, kill_fixture)
        if isinstance(execution_result, TaskResult):
            return execution_result
        data, approvals_triggered, approvals_resolved, early_fail_reason = execution_result
        if kill_evidence is not None:
            data["kill_agent_benchmark"] = kill_evidence
        if task.mid_run_feedback:
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "mid_run_feedback": getattr(task, "_mid_run_feedback_evidence", None) or {"posted": False},
            }
        early_fail_reason = _annotate_needs_auth_failure(task, early_fail_reason, data)
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None
        if _early_fail_should_pause_agent(early_fail_reason):
            try:
                if await pause_agent(base_url, agent_id):
                    print(f"    ⏸ Paused agent {agent_id[:12]} after early-fail before cleanup")
                    await _retire_owned_native_world(task, agent_id)
                    data = await _refresh_agent_after_pause_for_browser_terminal(base_url, agent_id, data)
                    # Wait for Session Cancelled (task_complete+task_id) before
                    # freezing the transcript into the durable hub archive.
                    data = await _await_claude_code_chip_terminality(base_url, agent_id, data)
            except Exception as pause_error:
                print(f"    ⚠ Failed to pause early-failed agent {agent_id[:12]}: {pause_error}")

        await _retire_owned_native_world(task, agent_id)

        # Get final agent data
        agent = data.get("agent", {})
        messages = data.get("messages", [])
        duration = time.time() - start

        # Get cost and cache metrics from tool usage
        cost_cents = 0.0
        cache_read_input_tokens = 0
        cache_creation_input_tokens = 0
        llm_call_count = 0
        tree_agent_count = 0
        tool_tokens_in = 0
        tool_tokens_out = 0
        tool_tokens_cover_tree = False
        tokens_in = 0
        tokens_out = 0
        try:
            agent_cost_cents = max(
                0.0,
                float(agent.get("tree_cost_cents") or agent.get("tool_cost_cents") or 0),
            )
        except (TypeError, ValueError):
            agent_cost_cents = 0.0
        minimum_cost_cents = agent_cost_cents
        if agent.get("status") == "COST_LIMIT_REACHED":
            minimum_cost_cents = max(minimum_cost_cents, float(task.price_limit_cents or 0))
        try:
            usage = await _get_settled_tool_usage(
                base_url, agent_id, minimum_cost_cents=minimum_cost_cents
            )
            cost_cents = max(float(usage.get("total_cost_cents") or 0), agent_cost_cents)
            cache_read_input_tokens = usage.get("cache_read_input_tokens", 0)
            cache_creation_input_tokens = usage.get("cache_creation_input_tokens", 0)
            llm_call_count = int(usage.get("llm_call_count") or 0)
            tree_agent_count = int(usage.get("agent_count") or 0)
            raw_tool_tokens_in = usage.get("tokens_in")
            raw_tool_tokens_out = usage.get("tokens_out")
            tool_tokens_cover_tree = raw_tool_tokens_in is not None or raw_tool_tokens_out is not None
            tool_tokens_in = int(raw_tool_tokens_in or 0)
            tool_tokens_out = int(raw_tool_tokens_out or 0)
            if not tool_tokens_in:
                tool_tokens_in = int(cache_read_input_tokens or 0) + int(cache_creation_input_tokens or 0)
        except Exception:
            # Fallback to agent-level cost fields
            cost_cents = agent_cost_cents

        if task.expected_payment_lifecycle:
            try:
                payment_lifecycle = await _get_initial_payment_lifecycle_with_retry(
                    base_url,
                    agent_id,
                )
                data["_benchmark"] = {
                    **data.get("_benchmark", {}),
                    "payment_lifecycle": payment_lifecycle,
                }
            except Exception as e:
                data["_benchmark"] = {
                    **data.get("_benchmark", {}),
                    "payment_lifecycle_error": str(e),
                }

        tree_stats = await _fetch_tree_stats(base_url, agent_id)
        llm_usage_by_provider, prompt_cache = await get_llm_usage_details(
            base_url,
            agent_id,
            tree_stats,
        )
        tree_agent_count = max(tree_agent_count, int(tree_stats.get("agent_count") or 0))
        tree_tokens_in = max(
            _as_nonnegative_int(tree_stats.get("tree_tokens_in")),
            _as_nonnegative_int(agent.get("tokens_in", agent.get("tokensIn"))),
        )
        tree_tokens_out = max(
            _as_nonnegative_int(tree_stats.get("tree_tokens_out")),
            _as_nonnegative_int(agent.get("tokens_out", agent.get("tokensOut"))),
        )
        tokens_in, tokens_out = _merge_tool_and_tree_tokens(
            tool_tokens_in,
            tool_tokens_out,
            tree_tokens_in,
            tree_tokens_out,
            tool_tokens_cover_tree=tool_tokens_cover_tree,
        )

        # Evaluate — early-fail reasons (per-agent stall, context error, timeout)
        # override a pass. evaluate_task still runs so post-completion checks
        # (expected tools, progress score) can provide additional diagnostics.
        passed, failure_reason = evaluate_task(task, data, approvals_triggered)
        evaluator_evidence = _webdecoy_score_evidence(data) if task.name == BIOMETRICS_WEBDECOY_TASK_NAME else None
        if early_fail_reason:
            passed = False
            if not failure_reason:
                failure_reason = early_fail_reason
            else:
                failure_reason = f"{early_fail_reason} | {failure_reason}"
        if task.name == AMAZON_AUTH_ASSISTANCE_TASK_NAME and _force_show_passwords_mode():
            passed, failure_reason = evaluate_force_show_passwords_auth_task(
                task,
                data,
                approvals_triggered,
                approvals_resolved,
            )
        if task.name == GREP_EXPLORE_STRESS_TASK_NAME:
            grep_passed, grep_reason = await evaluate_grep_explore_stress(
                base_url,
                agent_id,
                grep_fixture_manifest or {},
            )
            if not grep_passed:
                passed = False
                failure_reason = grep_reason
        if phone_callee is not None and passed:
            phone_passed, phone_reason = await _evaluate_phone_call_task(
                task,
                data,
                phone_callee,
                base_url=base_url,
                agent_id=agent_id,
            )
            if not phone_passed:
                passed = False
                failure_reason = phone_reason
        if task.name in PLAID_TRANSACTION_BENCHMARK_TASK_NAMES:
            plaid_passed, plaid_reason = await evaluate_plaid_transaction_task(
                task,
                base_url,
                agent_id,
                plaid_transactions_manifest or {},
            )
            if not plaid_passed:
                passed = False
                failure_reason = plaid_reason

        agent_class_step_counts = _agent_class_step_counts(data)
        data["_benchmark"] = {
            **data.get("_benchmark", {}),
            "agent_class_step_counts": agent_class_step_counts,
            "min_steps": dict(task.min_steps),
            "usage": {
                "cost_cents": float(cost_cents or 0),
                "cache_read_input_tokens": int(cache_read_input_tokens or 0),
                "cache_creation_input_tokens": int(cache_creation_input_tokens or 0),
                "tokens_in": int(tokens_in or 0),
                "tokens_out": int(tokens_out or 0),
                "live_output_tokens": live_output_tokens(llm_usage_by_provider),
            },
        }
        expected_gate_terminal = (
            task.expected_gate
            and data["_benchmark"].get("expected_gate_seen") is True
            and not task.simulate_gate_webhook
            and not task.complete_subscription_checkout
        )
        if not expected_gate_terminal:
            min_steps_error = _validate_agent_class_min_steps(
                task.min_steps,
                agent_class_step_counts,
            )
            if min_steps_error:
                passed = False
                failure_reason = f"{failure_reason} | {min_steps_error}" if failure_reason else min_steps_error

        # Tree agent count check — counts spawn_agent-type sub-agents only
        # (excludes root and explore agents; explore agents have no output_schema)
        if task.min_agent_count and passed:
            try:
                all_agents = tree_stats.get("all_agents", [])
                tree_agent_count = max(tree_agent_count, int(tree_stats.get("agent_count") or 0))
                spawn_agent_count = sum(1 for a in all_agents if a.get("parent_agent_id") and a.get("output_schema"))
                if spawn_agent_count < task.min_agent_count:
                    passed = False
                    failure_reason = (
                        f"Tree has {spawn_agent_count} spawn_agent-type sub-agents "
                        f"(excluding explores), expected >= {task.min_agent_count}"
                    )
            except Exception as e:
                print(f"    ⚠ Tree count check failed: {e}")

        # Tool count checks — tree-wide by default, with root scope available
        # for benchmarks that validate top-level orchestration paths only.
        if (task.expected_tool_counts or task.min_tool_counts or task.forbidden_tools) and passed:
            try:
                if task.tool_count_scope == "root":
                    actual_counts = _count_logical_tool_calls_from_messages(data.get("messages", []))
                else:
                    actual_counts = await count_tree_tool_calls(base_url, agent_id)
                if not llm_call_count:
                    llm_call_count = sum(int(v) for v in actual_counts.values() if isinstance(v, int))
                for tool_name, expected_count in (task.expected_tool_counts or {}).items():
                    actual = actual_counts.get(tool_name, 0)
                    if actual != expected_count:
                        passed = False
                        failure_reason = (
                            f"Tool '{tool_name}': expected {expected_count} call(s), "
                            f"got {actual}. Full counts: {actual_counts}"
                        )
                        break
                if passed:
                    tool_count_error = _validate_tool_count_expectations(
                        actual_counts,
                        task.min_tool_counts,
                        task.forbidden_tools,
                    )
                    if tool_count_error:
                        passed = False
                        failure_reason = tool_count_error
            except Exception as e:
                print(f"    ⚠ Tool count check failed: {e}")

        if task.name == USER_DATA_PROD_GREP_TASK_NAME and passed:
            try:
                prod_grep_contract_error = await validate_user_data_prod_grep_contract(base_url, agent_id)
                if prod_grep_contract_error:
                    passed = False
                    failure_reason = prod_grep_contract_error
            except BenchmarkJudgeUnavailable:
                raise
            except Exception as e:
                passed = False
                failure_reason = f"User-data prod grep contract check failed: {e}"

        if task.name in {AGENT_PAYMENT_TEST_SHOP_TASK_NAME, NEW_USER_PAYMENT_JOURNEY_TASK_NAME} and passed:
            try:
                payment_confirmation_error = await validate_agent_payment_confirmation_contract(data, agent_id)
                if payment_confirmation_error:
                    passed = False
                    failure_reason = payment_confirmation_error
            except BenchmarkJudgeUnavailable:
                raise
            except Exception as e:
                passed = False
                failure_reason = f"Agent payment confirmation contract check failed: {e}"

        current_lifecycle = data.get("_benchmark", {}).get("payment_lifecycle")
        if not passed:
            evaluated_failure_reason = failure_reason or "Task evaluation failed before payment cleanup"
        cleanup_lifecycle = await ensure_payment_lifecycle_cleanup(
            base_url,
            agent_id,
            task,
            current_lifecycle=current_lifecycle if isinstance(current_lifecycle, dict) else None,
        )
        if cleanup_lifecycle is not None:
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "payment_card_request_action": "abandon",
                "payment_lifecycle": cleanup_lifecycle,
            }
            cleanup_error = _validate_payment_lifecycle(task, data)
            if cleanup_error is not None:
                passed = False
                failure_reason = cleanup_error
        elif task.payment_card_request_action == "abandon":
            passed = False
            failure_reason = failure_reason or "payment lifecycle cleanup did not complete"

        if task.payment_card_request_action == "abandon":
            data, browser_archive_error = await _seal_payment_abandonment_browser_for_archive(
                base_url,
                agent_id,
                data,
            )
            agent = data.get("agent", {})
            messages = data.get("messages", [])
            if browser_archive_error is not None:
                passed = False
                failure_reason = (
                    f"{failure_reason} | {browser_archive_error}" if failure_reason else browser_archive_error
                )

        # Final context well-formedness check
        approval_mode_blocked_on_approval = _approval_mode_allows_open_tool_context(
            task,
            data,
            approvals_triggered,
        )
        final_violations = _final_context_violations_for_result(
            task,
            data,
            approvals_triggered,
            validate_context(messages),
        )
        context_violation_dicts = [v.to_dict() for v in final_violations]
        context_errors = [v for v in final_violations if v.severity == "error"]
        if context_errors and passed and not approval_mode_blocked_on_approval:
            # Override pass → fail if context has well-formedness errors
            passed = False
            failure_reason = f"Context well-formedness errors: {context_errors[0].message}"
        if final_violations:
            error_count = len(context_errors)
            warn_count = len(final_violations) - error_count
            print(f"    Context validation: {error_count} errors, {warn_count} warnings")

        declared_evaluator_results: list[dict] = []
        run_declared = task.enforce_declared_evaluators and (
            passed or _task_declares_static_check(task, "claude_code_session_output")
        )
        if run_declared and passed:
            try:
                tree_agents = await get_agent_tree(base_url, agent_id)
                tree = canonicalize_agent_tree(
                    await collect_tree_messages(agent_id, tree_agents, lambda a: get_agent(base_url, a))
                )
                data["_benchmark"] = {
                    **data.get("_benchmark", {}),
                    "tree": tree,
                    "all_agents": tree_agents,
                    "cost_cents": cost_cents,
                    "cache_creation_input_tokens": cache_creation_input_tokens,
                    "cache_read_input_tokens": cache_read_input_tokens,
                    "live_output_tokens": tokens_out,
                    "tree_tokens_out": tree_tokens_out,
                }
            except Exception as tree_err:
                data["_benchmark"] = {
                    **data.get("_benchmark", {}),
                    "tree": data.get("_benchmark", {}).get("tree") or {},
                    "all_agents": tree_stats.get("all_agents", []),
                    "tree_capture_error": str(tree_err),
                    "cost_cents": cost_cents,
                    "cache_creation_input_tokens": cache_creation_input_tokens,
                    "cache_read_input_tokens": cache_read_input_tokens,
                    "live_output_tokens": tokens_out,
                    "tree_tokens_out": tree_tokens_out,
                }
        if run_declared:
            data.setdefault("_benchmark", {})["api_base_url"] = base_url
            evaluator_passed, evaluator_reason, declared_evaluator_results = await _run_declared_evaluators(
                task,
                data,
                base_url=base_url,
                static_only=not passed,
            )
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "declared_evaluator_results": declared_evaluator_results,
            }
            if not evaluator_passed:
                passed = False
                failure_reason = evaluator_reason

        # Collect diagnostic logs; prod log APIs only for prod-backed runs.
        print("    Collecting logs...")
        logs = await collect_logs(agent_id, data, start_time, backend_url=base_url)
        logs = _native_world_retirement_diagnostics(task, logs)
        if declared_evaluator_results:
            logs["declared_evaluators"] = declared_evaluator_results
        # Keep hydrated Claude Code transcripts in the run JSON so durable FE
        # publish can dual-write them after the ephemeral bench DB is dropped.
        claude_code_sessions = (data.get("_benchmark") or {}).get("claude_code_sessions")
        if isinstance(claude_code_sessions, list) and claude_code_sessions:
            logs["claude_code_sessions"] = claude_code_sessions
        session_evidence_error = (data.get("_benchmark") or {}).get("claude_code_session_evidence_error")
        if session_evidence_error:
            logs["claude_code_session_evidence_error"] = session_evidence_error
        auth_test_site_evidence = (data.get("_benchmark") or {}).get("auth_test_site")
        if not auth_test_site_evidence and auth_test_site.active_manifest():
            # A run that failed before its evaluators still needs the site's own
            # record: it is the only account of what the agent actually tried.
            await _hydrate_auth_test_site_evidence(data, base_url, task=task)
            auth_test_site_evidence = (data.get("_benchmark") or {}).get("auth_test_site")
        if auth_test_site_evidence:
            logs["auth_test_site"] = auth_test_site_evidence
        # Capture the FULL agent tree's messages (root + every spawned sub-agent) so
        # the archive can render the fan-out, not just the root. Without this a
        # for_each/spawn benchmark opens to a lone root with no visible tree. Only
        # when the run actually fanned out (>1 agent); best-effort — a capture
        # failure must never fail the benchmark itself.
        if tree_agent_count and tree_agent_count > 1:
            try:
                tree_agents = await get_agent_tree(base_url, agent_id)
                tree = canonicalize_agent_tree(
                    await collect_tree_messages(agent_id, tree_agents, lambda a: get_agent(base_url, a))
                )
                if kill_evidence is not None:
                    # Killed fixtures are absent from the active-tree API. Preserve their
                    # actual pre-kill transcripts with verified terminal workflow states.
                    tree.update(kill_evidence["fixture"]["tree"])
                if not tree:
                    raise RuntimeError("collect_tree_messages returned a non-agent logs.tree")
                child_transcripts = tree_child_transcript_count(tree, agent_id)
                if child_transcripts == 0:
                    raise RuntimeError("logs.tree has no child transcripts; refusing to archive empty fan-out chips")
                logs["tree"] = tree
                print(
                    f"    Tree messages captured for {len(logs['tree'])} agent(s) "
                    f"({child_transcripts} child transcripts)"
                )
            except Exception as tree_err:
                print(f"    ⚠ tree-message capture failed (archive shows root only): {tree_err}")
        log_summary = []
        for key, label in [
            ("backend_logs", "backend"),
            ("worker_logs", "worker"),
            ("research_logs", "research"),
            ("realtime_logs", "realtime"),
        ]:
            entries = logs.get(key, [])
            log_summary.append(f"{label}={len(entries)}")
        log_summary.append(f"messages={len(logs.get('messages', []))}")
        print(f"    Logs collected: {', '.join(log_summary)}")
        failure_reason = _annotate_needs_auth_failure(task, failure_reason, data)
        archive_manifest_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
            base_url,
            agent_id,
            task.name,
            benchmark_passed=passed,
            benchmark_status="PASSED" if passed else "FAILED",
            failure_reason=failure_reason,
        )

        # Compute cache hit rate
        total_input = cache_read_input_tokens + cache_creation_input_tokens
        cache_hit_pct = round(cache_read_input_tokens / total_input * 100, 1) if total_input > 0 else 0.0

        result = TaskResult(
            name=task.name,
            passed=passed,
            agent_id=agent_id,
            status=agent.get("status", "UNKNOWN"),
            benchmark_status="PASSED" if passed else "FAILED",
            progress_score=agent.get("progress", 0),
            duration_seconds=round(duration, 1),
            cost_cents=round(cost_cents, 2),
            message_count=len(messages),
            failure_reason=failure_reason,
            evaluator_evidence=evaluator_evidence,
            approvals_triggered=approvals_triggered,
            approvals_resolved=approvals_resolved,
            cache_read_input_tokens=cache_read_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_hit_pct=cache_hit_pct,
            prompt_cache_read_input_tokens=int(prompt_cache["cache_read_input_tokens"]),
            prompt_cache_creation_input_tokens=int(prompt_cache["cache_creation_input_tokens"]),
            prompt_cache_uncached_input_tokens=int(prompt_cache["uncached_input_tokens"]),
            prompt_cache_share_pct=float(prompt_cache["cache_share_pct"]),
            prompt_cache_call_count=int(prompt_cache["call_count"]),
            prompt_cache_routes=list(prompt_cache["routes"]),
            prompt_cache_warmup=prompt_cache_warmup,
            llm_call_count=llm_call_count,
            tree_agent_count=tree_agent_count,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            llm_usage_by_provider=llm_usage_by_provider,
            stop_metadata={
                "llm_call_count": llm_call_count,
                "tree_agent_count": tree_agent_count,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "message_count": len(messages),
                "status": agent.get("status", "UNKNOWN"),
                "cost_cents": round(cost_cents, 2),
                "cache_hit_pct": cache_hit_pct,
            },
            fast_mode_cache_enabled=_reported_fast_mode_cache_enabled(task, agent),
            context_violations=context_violation_dicts,
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            payment_lifecycle=(data.get("_benchmark") or {}).get("payment_lifecycle"),
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
            wmh_initial_state=_wmh_initial_state_evidence(task),
        )

        # Evaluation is complete. Publish its outcome before releasing agent
        # resources or entering the phone/fixture cleanup in finally.
        if on_task_evaluated is not None:
            try:
                publication = on_task_evaluated(result)
                if inspect.isawaitable(publication):
                    await publication
            except Exception as exc:
                print(f"    ⚠ evaluated outcome publication failed: {type(exc).__name__}")

        icon = "✅" if passed else "❌"
        print(f"\n    {icon} {task.name}: {'PASS' if passed else 'FAIL'}")
        if failure_reason:
            print(f"       Reason: {failure_reason}")
        print(f"       Duration: {duration:.1f}s | Cost: {cost_cents:.1f}c | Messages: {len(messages)}")
        if total_input > 0:
            print(
                f"       Cache: read={cache_read_input_tokens} write={cache_creation_input_tokens} hit={cache_hit_pct}%"
            )
        if result.prompt_cache_warmup is not None:
            warm = result.prompt_cache_warmup
            print(
                "       Prompt-cache warmup (not scored): "
                f"route={warm.get('token_type')} read={warm.get('cache_read_input_tokens')} "
                f"write={warm.get('cache_creation_input_tokens')} uncached={warm.get('uncached_input_tokens')}"
                + (f" error={warm['error']}" if warm.get("error") else "")
            )
        if result.prompt_cache_call_count > 0:
            print(
                "       Prompt-cache share: "
                f"read={result.prompt_cache_read_input_tokens} "
                f"write={result.prompt_cache_creation_input_tokens} "
                f"uncached={result.prompt_cache_uncached_input_tokens} "
                f"share={result.prompt_cache_share_pct}% over {result.prompt_cache_call_count} sequenced calls "
                f"routes={','.join(result.prompt_cache_routes) or 'none'} "
                f"floor={route_cache_floor(task.name, result.prompt_cache_routes)}"
            )

        # Clean up: delete the agent now that we've collected all data, unless
        # the caller explicitly wants failed agents kept alive for diagnostics.
        if _should_delete_agent_after_run(passed, keep_failed_agents):
            try:
                await delete_agent(base_url, agent_id)
                print(f"    🗑  Deleted agent {agent_id[:12]}")
            except Exception:
                print(f"    ⚠ Failed to delete agent {agent_id[:12]}")
        elif os.environ.get("BENCHMARK_KEEP_AGENTS") == "true":
            print(f"    🧪 Keeping agent {agent_id[:12]} for UI audit")
        else:
            keep_reason = "benchmark agent" if passed else "failed agent"
            print(f"    🧪 Keeping {keep_reason} {agent_id[:12]} for diagnostics")

        return result

    except asyncio.CancelledError as e:
        duration = time.time() - start
        interrupt_cleanup_started = _begin_interrupt_cleanup() if cloud_batch_cleanup.contract() is None else False
        cancelled_agent_deleted = False
        cancellation_cleanup_ok = True
        agent_id = _recover_owned_native_admission_root(task, agent_id)
        print(f"\n    ⚠ {task.name}: CANCELLED — collecting logs before shutdown")
        try:
            await _retire_owned_native_world(task, agent_id)
        except Exception:
            pass  # Unproven join is retained below; independent cleanup still owns its resources.
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None
        logs = None
        messages = []
        status = "CANCELLED"
        progress_score = 0
        if agent_id:
            data, logs = await _capture_task_failure_evidence(
                base_url, agent_id, task, data or last_snapshot, start_time,
            )
            messages = data.get("messages", [])
            status = data.get("agent", {}).get("status", "CANCELLED")
            progress_score = data.get("agent", {}).get("progress", 0)
            try:
                archive_manifest_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
                    base_url,
                    agent_id,
                    task.name,
                    force=True,
                    benchmark_passed=False,
                    benchmark_status="CANCELLED",
                    failure_reason="Benchmark interrupted; prod logs were collected before shutdown",
                )
            except Exception as archive_error:
                logs["failure_evidence"]["errors"].append(
                    f"archive: {type(archive_error).__name__}: {archive_error}")
            try:
                await ensure_payment_lifecycle_cleanup(base_url, agent_id, task)
            except Exception as cleanup_error:
                cancellation_cleanup_ok = False
                logs["failure_evidence"]["errors"].append(f"cleanup: {type(cleanup_error).__name__}: {cleanup_error}")
            if interrupt_cleanup_started:
                if not _should_delete_cancelled_agent(keep_failed_agents):
                    raise RuntimeError("owner-requested benchmark teardown cannot retain the cancelled agent")
                cancelled_agent_deleted = await _delete_owned_native_admission_root(base_url, task, agent_id)
                print(
                    f"    🗑  {'Deleted cancelled agent' if cancelled_agent_deleted else 'Observed absent root'} {agent_id[:12]}"
                )
            else:
                try:
                    if _should_delete_cancelled_agent(keep_failed_agents):
                        cancelled_agent_deleted = await _delete_owned_native_admission_root(base_url, task, agent_id)
                        print(
                            f"    🗑  {'Deleted cancelled agent' if cancelled_agent_deleted else 'Observed absent root'} {agent_id[:12]}"
                        )
                    else:
                        print(f"    🧪 Keeping cancelled agent {agent_id[:12]} for diagnostics")
                except Exception:
                    print(f"    ⚠ Failed to delete cancelled agent {agent_id[:12]}")
        interrupt_cleanup_ready = interrupt_cleanup_started and cancellation_cleanup_ok and cancelled_agent_deleted
        print(
            f"    Interrupt cleanup evidence: root_target_known={bool(agent_id)} delete_confirmed={cancelled_agent_deleted}"
        )
        logs = _native_world_retirement_diagnostics(task, logs, e)
        retirement_failed = getattr(task, "_wmh_retirement_error", None) is not None
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id=agent_id,
            status="ERROR" if retirement_failed else status,
            benchmark_status="ERROR" if retirement_failed else "CANCELLED",
            progress_score=progress_score,
            duration_seconds=round(duration, 1),
            cost_cents=0,
            message_count=len(messages),
            failure_reason=(
                "Benchmark interrupted; prod logs were collected before shutdown"
                + _native_world_retirement_failure_reason(task)
                + (f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}" if agent_id else "")
            ),
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
        )

    except Exception as e:
        duration = time.time() - start
        release_stall = (
            isinstance(e, AgentCardReleaseStall)
            and _agentcard_release_skip_lifecycle(task.name, e.lifecycle)
            and _agentcard_release_skip_enabled()
        )
        release_skip = release_stall and _agentcard_release_prior_failure_is_settlement_only(
            task.name, evaluated_failure_reason, e.lifecycle
        )
        token_skip = isinstance(e, ComputeTokenUnavailable) and evaluated_failure_reason is None
        # The two-run auth tasks' first agent failing its goal is a task verdict,
        # exactly as the graded run scores it; every other exception is untrusted.
        first_run_failed = isinstance(e, auth_test_site.AuthTestSiteFirstRunFailed)
        error_status = "SKIPPED" if release_skip or token_skip else "FAILED" if first_run_failed else "ERROR"
        agent_id = _recover_owned_native_admission_root(task, agent_id)
        try:
            await _retire_owned_native_world(task, agent_id)
        except Exception:
            pass  # Evidence/archive/agent cleanup must continue after an unproven native join.
        if getattr(task, "_wmh_retirement_error", None) is not None:
            release_skip = token_skip = False
            error_status = "ERROR"
        if release_skip:
            _warn_agentcard_release_skip(task.name, str(e))
        elif token_skip:
            print(f"\n    ⚠️ SKIPPED {task.name}: {COMPUTE_TOKEN_UNAVAILABLE_SKIP_REASON}: {e}")
        else:
            print(f"\n    ❌ {task.name}: {error_status} - {type(e).__name__}: {e}")
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None
        logs = None
        if agent_id:
            data, logs = await _capture_task_failure_evidence(
                base_url, agent_id, task, data or last_snapshot, start_time,
            )
            if release_stall:
                logs["agentcard_release_stall_lifecycle"] = e.lifecycle
            try:
                archive_manifest_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
                    base_url,
                    agent_id,
                    task.name,
                    force=True,
                    benchmark_passed=False,
                    benchmark_status=error_status,
                    failure_reason=str(e),
                )
            except Exception as archive_error:
                logs["failure_evidence"]["errors"].append(
                    f"archive: {type(archive_error).__name__}: {archive_error}")
        if release_skip and logs and logs.get("failure_evidence", {}).get("errors"):
            error_status = "ERROR"
        logs = _native_world_retirement_diagnostics(task, logs, e)
        result = TaskResult(
            name=task.name,
            passed=False,
            agent_id=agent_id,
            status=error_status,
            benchmark_status=error_status,
            progress_score=0,
            duration_seconds=round(duration, 1),
            cost_cents=0,
            message_count=len(data.get("messages", [])),
            failure_reason=(
                (f"{AGENTCARD_RELEASE_SKIP_REASON}: " if release_skip else "")
                + (f"{COMPUTE_TOKEN_UNAVAILABLE_SKIP_REASON}: " if token_skip else "")
                + f"{e}"
                + _native_world_retirement_failure_reason(task)
                + (f" | Prior task failure: {evaluated_failure_reason}" if evaluated_failure_reason else "")
                + (f" | Independent evidence/cleanup errors: {logs['failure_evidence']['errors']}" if release_skip and error_status == "ERROR" else "")
                + (f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}" if agent_id else "")
                + " | Cache/cost: python agents/benchmarks/run_benchmark.py --compare <run.json>"
            ),
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
        )
        if on_task_evaluated is not None:
            try:
                publication = on_task_evaluated(result)
                if inspect.isawaitable(publication):
                    await publication
            except Exception as exc:
                print(f"    ⚠ evaluated outcome publication failed: {type(exc).__name__}")
        if agent_id:
            try:
                # The typed skip already owns a completed, bounded close/reclaim
                # attempt. Preserve its liability instead of running that wait twice.
                if not release_stall:
                    await ensure_payment_lifecycle_cleanup(base_url, agent_id, task)
            except Exception as cleanup_error:
                logs["failure_evidence"]["errors"].append(f"cleanup: {type(cleanup_error).__name__}: {cleanup_error}")
            try:
                if not keep_failed_agents and cloud_batch_cleanup.contract() is None:
                    deleted = await _delete_owned_native_admission_root(base_url, task, agent_id)
                    print(f"    🗑  {'Deleted orphaned agent' if deleted else 'Observed absent root'} {agent_id[:12]}")
                else:
                    print(f"    🧪 Keeping failed agent {agent_id[:12]} for diagnostics")
            except Exception as deletion_error:
                print(f"    ⚠ Failed to delete orphaned agent {agent_id[:12]}")
                if release_skip:
                    logs["failure_evidence"]["errors"].append(f"delete: {deletion_error}")
                    result.status = result.benchmark_status = "ERROR"
                    result.failure_reason = f"Execution cleanup failed after AgentCard release skip: {deletion_error}"
        return result

    finally:
        realtime_tree_error = None
        if realtime_tree_task:
            try:
                await _stop_realtime_tree_capture(realtime_tree_task, realtime_tree_stop)
            except Exception as exc:
                realtime_tree_error = exc
        if realtime_monitor:
            await realtime_monitor.stop()
        if phone_callee is not None:
            await phone_callee.cleanup()
        for tmp in temp_csv_paths:
            try:
                if os.path.isdir(tmp):
                    shutil.rmtree(tmp)
                else:
                    os.unlink(tmp)
            except OSError:
                pass
        if plaid_transactions_fixture_action == "apply" and os.environ.get("BENCHMARK_CLEANUP_PLAID_FIXTURE") == "1":
            try:
                _run_plaid_transactions_fixture("cleanup")
            except Exception as exc:
                print(f"    ⚠ Failed to clean up synthetic Plaid transaction fixture: {exc}")
        await _restore_live_fixture_scenarios_async(live_fixture_manifests)
        await _release_auth_test_site(base_url, auth_test_site_manifest)
        if previous_active_task_name is None:
            os.environ.pop("BENCHMARK_ACTIVE_TASK_NAME", None)
        else:
            os.environ["BENCHMARK_ACTIVE_TASK_NAME"] = previous_active_task_name
        if previous_active_task_block_dom_patch is None:
            os.environ.pop("BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH", None)
        else:
            os.environ["BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH"] = previous_active_task_block_dom_patch
        if previous_disable_saved_browser_auth is None:
            os.environ.pop("BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", None)
        else:
            os.environ["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = previous_disable_saved_browser_auth
        if interrupt_cleanup_ready:
            _complete_interrupt_cleanup()
        if realtime_tree_error is not None:
            raise realtime_tree_error


def _validate_task_target(task: BenchmarkTask, base_url: str) -> None:
    if task.production_only and _is_local_base_url(base_url):
        raise RuntimeError(f"{task.name} is production-only; rerun with --prod")


def _agentcard_setup_fixture_action(task: BenchmarkTask, base_url: str) -> Optional[str]:
    # Production-only lifecycles must exercise the user's real AgentCard
    # integration. Completing the benchmark setup fixture against production
    # replaces that path with a sandbox cardholder, making every provider
    # transfer report livemode=false and defeating this gate's purpose.
    if task.production_only:
        return None
    if task.agentcard_setup_action == "complete":
        return "reset"
    if task.expected_payment_lifecycle:
        return "complete"
    return None


# ============================================================
# Main
# ============================================================


def task_names_from_args(args) -> list[str]:
    """Return explicit task names from argparse output.

    `--task` accepts repeated values and comma-separated values so wrappers can
    pass an exact task set without encoding it as "suite all minus exclusions".
    """
    values = getattr(args, "task", None)
    if not values:
        return []
    if isinstance(values, str):
        values = [values]

    names: list[str] = []
    for value in values:
        names.extend(name.strip() for name in str(value).split(",") if name.strip())
    return names


def resolve_tasks(args) -> List[BenchmarkTask]:
    """Resolve which tasks to run from CLI args."""
    explicit_task_names = task_names_from_args(args)
    if explicit_task_names:
        tasks = [get_task_by_name(name) for name in explicit_task_names]
        unsupported = [task for task in tasks if task.runner not in RUNNABLE_TASK_RUNNERS]
        if unsupported:
            names = ", ".join(f"{task.name} ({task.runner})" for task in unsupported)
            raise ValueError(
                f"Task(s) {names} are not runnable here — run them via "
                f"benchmarks/run_eval_suite.py or their own test runner, not run_benchmark.py."
            )
    elif args.suite:
        if args.suite == "all":
            # Default "all" stays on the first-party catalog. Polar Odysseys +
            # BU Bench V1 (~300 live browser tasks) are opt-in via
            # `--suite polar-bench` so full-suite / daily fleets never fan out.
            tasks = [t for t in all_tasks() if not is_polar_bench_task(t)]
        elif args.suite == "auth":
            # The anon/cookie split used to live on dedicated tags; the curated
            # tag vocabulary merged them into `auth`, so the split is by name.
            auth_names = (
                ("browser-agent",) if getattr(args, "anon", False) else ("browser-agent-amazon-cookie-payment",)
            )
            tasks = [get_task_by_name(name) for name in auth_names]
        elif args.suite in ("rose-bench", "pipeline-e2e"):
            # Bench axis: rose-bench = harness-independent capability evals,
            # pipeline-e2e = harness plumbing tests. Orthogonal to tag slices.
            # Polar tasks also declare bench=rose-bench but stay behind the
            # polar-bench suite tag so this axis stays first-party-sized.
            tasks = [t for t in all_tasks() if t.bench == args.suite and not is_polar_bench_task(t)]
        else:
            tasks = get_tasks_by_tag(args.suite)
    else:
        tasks = [t for t in all_tasks() if not is_polar_bench_task(t)]

    if not explicit_task_names:
        # Suite selection only runs complete benchmark evals. `status == "incomplete"`
        # entries (missing fixtures/judges) are skipped; explicit --task still targets
        # incomplete agent evals for dev iteration.
        tasks = [t for t in tasks if t.runner in RUNNABLE_TASK_RUNNERS and t.status == "ready"]
        if not getattr(args, "prod", False):
            tasks = [t for t in tasks if not t.production_only]

    excluded_names: set[str] = set()
    for value in getattr(args, "exclude_task", []) or []:
        excluded_names.update(name.strip() for name in value.split(",") if name.strip())
    if not excluded_names:
        return tasks

    known_names = {task.name for task in all_tasks()}
    unknown_names = sorted(excluded_names - known_names)
    if unknown_names:
        raise ValueError(f"Unknown --exclude-task value(s): {', '.join(unknown_names)}")

    return [task for task in tasks if task.name not in excluded_names]


async def _warmup_edge_functions(base_url: str):
    """Warm an explicitly configured legacy research edge function.

    Research is retired in the standard local stack, where backend port + 3 is now
    the mac app. Only environments that still configure RESEARCH_PORT have an edge
    function to warm.
    """
    research_port = os.environ.get("RESEARCH_PORT")
    if not research_port:
        print("  ⚠ Skipping edge function warmup (RESEARCH_PORT is not configured)")
        return

    completions_url = f"http://localhost:{research_port}/functions/v1/completions"
    anon_key = os.environ.get("SUPABASE_ANON_KEY", os.environ.get("VITE_SUPABASE_ANON_KEY", ""))
    api_key = os.environ.get("ROSE_API_KEY", "")
    if not anon_key:
        print("  ⚠ Skipping edge function warmup (no SUPABASE_ANON_KEY)")
        return

    payload = {
        "model": "rose-labs/rose-1-flash",
        "messages": [{"role": "user", "content": "Say hi"}],
        "max_tokens": 5,
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {anon_key}",
        "x-api-key": api_key,
    }

    print("  🔥 Warming up edge functions (DNS resolution)...", end="", flush=True)
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        for attempt in range(1, 11):
            try:
                resp = await client.post(completions_url, json=payload, headers=headers)
                if 200 <= resp.status_code < 300:
                    print(f" ready ({attempt} attempt(s))", flush=True)
                    return
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout, Exception) as e:
                if attempt == 1:
                    print(f" (attempt {attempt}: {type(e).__name__})", end="", flush=True)
            await asyncio.sleep(2)
    print(" ⚠ warmup did not succeed after 10 attempts (continuing anyway)", flush=True)


def _verify_worker_queue_alignment():
    """Verify a local worker process is running on the expected task queue.

    Derives the expected queue from CONDUCTOR_WORKSPACE_NAME (matching run.sh's
    derivation), then checks each `python worker.py` process in this workspace
    to confirm it matches.
    """
    import subprocess

    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace:
        print("  ❌ CONDUCTOR_WORKSPACE_NAME not set — cannot derive task queue")
        sys.exit(1)
    expected_queue = f"navi-agent-tasks-{workspace}"

    result = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True)
    workspace_root = Path(__file__).resolve().parents[2]
    pids = _worker_pids_for_workspace(result.stdout, workspace_root)
    if not pids:
        print(f"  ❌ No worker process found (expected on queue {expected_queue})")
        print(f"     Start it: TEMPORAL_TASK_QUEUE={expected_queue} python worker.py &")
        sys.exit(1)

    unreadable_pids: list[str] = []
    mismatched: list[tuple[str, str]] = []
    for pid in pids:
        worker_queue = _read_process_env_var(pid, "TEMPORAL_TASK_QUEUE")
        if worker_queue is None:
            unreadable_pids.append(pid)
            continue
        if worker_queue != expected_queue:
            mismatched.append((pid, worker_queue))
            continue
        print(f"  ✅ Worker aligned on queue {expected_queue}")
        if mismatched:
            skipped = ", ".join(f"{pid}:{queue}" for pid, queue in mismatched[:3])
            suffix = "..." if len(mismatched) > 3 else ""
            print(f"  ℹ Ignoring other worker queue(s) in this worktree: {skipped}{suffix}")
        return

    if mismatched:
        first_pid, first_queue = mismatched[0]
        print(f"  ❌ Worker (pid {first_pid}) on queue '{first_queue}' but benchmark expects '{expected_queue}'")
        print(f"     Start a worker with: TEMPORAL_TASK_QUEUE={expected_queue} python worker.py &")
        sys.exit(1)

    print(
        f"  ❌ Worker process(es) {', '.join(unreadable_pids)} found for this workspace, "
        f"but TEMPORAL_TASK_QUEUE could not be verified"
    )
    sys.exit(1)


def _extract_worker_pids_from_ps(ps_output: str, workspace_root: str | None = None) -> list[str]:
    """Extract Python worker PIDs from portable ps output."""
    pids = []
    normalized_root = workspace_root.rstrip("/") if workspace_root else None
    for line in ps_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split(None, 1)
        if len(parts) != 2:
            continue
        pid, command = parts
        command_lower = command.lower()
        if normalized_root and normalized_root not in command:
            continue
        if "worker.py" in command_lower and "python" in command_lower:
            pids.append(pid)
    return pids


def _worker_pids_for_workspace(ps_output: str, workspace_root: Path, process_factory=None) -> list[str]:
    """Return worker PIDs whose cwd is inside this workspace.

    macOS `ps` output often contains only `python worker.py`, so command-string
    filtering is not enough to distinguish concurrent Conductor workspaces.
    """
    root_pids = _extract_worker_pids_from_ps(ps_output)
    agents_root = workspace_root / "agents"
    if process_factory is None:
        try:
            import psutil

            process_factory = psutil.Process
        except Exception:
            return _extract_worker_pids_from_ps(ps_output, str(workspace_root))

    matched: list[str] = []
    for pid in root_pids:
        try:
            proc = process_factory(int(pid))
            if _process_cwd_is_under(proc, agents_root):
                matched.append(pid)
        except Exception:
            continue
    return matched


def _read_process_env_var(pid: str, key: str, process_factory=None) -> str | None:
    """Read an environment variable from a process on macOS/Linux."""
    if process_factory is None:
        try:
            import psutil

            process_factory = psutil.Process
        except Exception:
            process_factory = None

    if process_factory is not None:
        try:
            return process_factory(int(pid)).environ().get(key)
        except Exception:
            pass

    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            env_bytes = f.read()
        prefix = f"{key}=".encode()
        for pair in env_bytes.split(b"\0"):
            if pair.startswith(prefix):
                return pair.split(b"=", 1)[1].decode()
    except (FileNotFoundError, PermissionError, OSError):
        return None
    return None


def _process_cwd_is_under(proc, expected_root: Path) -> bool:
    """Return whether a process cwd is inside the expected workspace root."""
    cwd = Path(proc.cwd()).resolve()
    expected = expected_root.resolve()
    return cwd == expected or expected in cwd.parents


def _memory_mb(byte_count: int) -> float:
    return round(byte_count / 1024 / 1024, 1)


def _local_worker_health_url(base_url: str) -> str | None:
    """Return the local worker health URL paired with a local backend URL."""
    configured = os.environ.get("SMOKE_HEALTH_URL")
    if configured:
        return configured.rstrip("/")

    parsed = urlparse(base_url)
    if parsed.hostname not in ("localhost", "127.0.0.1") or parsed.port is None:
        return None
    return f"{parsed.scheme}://{parsed.hostname}:{parsed.port + 2}"


async def _stabilize_local_worker_memory(base_url: str, phase: str) -> dict:
    """Ask the local worker to warm lazy benchmark imports and collect memory."""
    health_url = _local_worker_health_url(base_url)
    if not health_url:
        return {"attempted": False, "reason": "no local worker health URL"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(f"{health_url}/benchmark/memory-baseline")
        if response.status_code == 404:
            return {"attempted": True, "enabled": False, "status": response.status_code}
        response.raise_for_status()
        data = response.json()
        print(
            "  🧠 Worker memory baseline "
            f"({phase}): imported={len(data.get('imported', []))} "
            f"gc_collected={data.get('gc_collected', 0)}"
        )
        return {"attempted": True, "enabled": True, "status": response.status_code, **data}
    except Exception as exc:
        print(f"  ⚠ Worker memory baseline ({phase}) failed: {exc}")
        return {"attempted": True, "enabled": False, "reason": str(exc)}


def _sample_local_worker_memory() -> dict:
    """Return worker process-tree memory for local smoke leak detection."""
    import subprocess

    try:
        import psutil
    except Exception as e:
        return {"available": False, "reason": f"psutil unavailable: {e}"}

    result = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True)
    workspace_root = Path(__file__).resolve().parents[2]
    agents_root = workspace_root / "agents"
    root_pids = _extract_worker_pids_from_ps(result.stdout)
    if not root_pids:
        return {"available": False, "reason": "no local python worker.py process found"}

    seen: set[int] = set()
    processes: list[dict] = []
    sampled_root_pids: list[str] = []
    total_rss_bytes = 0
    playwright_driver_count = 0
    playwright_driver_rss_bytes = 0

    for root_pid in root_pids:
        try:
            root = psutil.Process(int(root_pid))
            if not _process_cwd_is_under(root, agents_root):
                continue
            tree = [root] + root.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError):
            continue

        sampled_root_pids.append(root_pid)
        for proc in tree:
            if proc.pid in seen:
                continue
            seen.add(proc.pid)
            try:
                rss_bytes = proc.memory_info().rss
                command = " ".join(proc.cmdline()) or proc.name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

            total_rss_bytes += rss_bytes
            is_playwright_driver = "playwright/driver" in command and "run-driver" in command
            if is_playwright_driver:
                playwright_driver_count += 1
                playwright_driver_rss_bytes += rss_bytes
            processes.append(
                {
                    "pid": proc.pid,
                    "rss_mb": _memory_mb(rss_bytes),
                    "is_playwright_driver": is_playwright_driver,
                    "command": command[:240],
                }
            )

    if not sampled_root_pids:
        return {"available": False, "reason": f"no local python worker.py process found under {agents_root}"}

    return {
        "available": True,
        "root_pids": sampled_root_pids,
        "process_count": len(processes),
        "total_rss_mb": _memory_mb(total_rss_bytes),
        "playwright_driver_count": playwright_driver_count,
        "playwright_driver_rss_mb": _memory_mb(playwright_driver_rss_bytes),
        "processes": sorted(processes, key=lambda p: p["rss_mb"], reverse=True),
    }


def _build_smoke_memory_summary(
    before: dict,
    after: dict,
    baseline: dict | None = None,
    platform_name: str | None = None,
) -> dict:
    """Build memory leak gate output for local smoke runs."""
    platform_value = platform_name or sys.platform
    allocator_trimmed = bool((baseline or {}).get("after", {}).get("allocator_trimmed"))
    enforce_growth = platform_value != "darwin" or allocator_trimmed
    process_count = int(after.get("process_count") or before.get("process_count") or 0)
    scaled_max_end_mb = process_count * SMOKE_MEMORY_MAX_WORKER_MB if process_count > 0 else 0.0
    effective_max_end_mb = max(SMOKE_MEMORY_MAX_END_MB, scaled_max_end_mb)
    summary = {
        "enabled": True,
        "before": before,
        "after": after,
        "baseline": baseline or {},
        "thresholds": {
            "max_growth_mb": SMOKE_MEMORY_MAX_GROWTH_MB,
            "max_end_mb": SMOKE_MEMORY_MAX_END_MB,
            "max_worker_mb": SMOKE_MEMORY_MAX_WORKER_MB,
            "effective_max_end_mb": effective_max_end_mb,
            "forbid_playwright_drivers": SMOKE_MEMORY_FORBID_PLAYWRIGHT_DRIVERS,
            "growth_enforced": enforce_growth,
        },
        "failures": [],
    }
    if not before.get("available") or not after.get("available"):
        summary["failures"].append(
            f"memory sampling unavailable: before={before.get('reason')} after={after.get('reason')}"
        )
        return summary

    growth_mb = round(after["total_rss_mb"] - before["total_rss_mb"], 1)
    summary["growth_mb"] = growth_mb

    if enforce_growth and growth_mb > SMOKE_MEMORY_MAX_GROWTH_MB:
        summary["failures"].append(
            f"worker process-tree RSS grew by {growth_mb} MB (> {SMOKE_MEMORY_MAX_GROWTH_MB} MB)"
        )
    elif not enforce_growth and growth_mb > SMOKE_MEMORY_MAX_GROWTH_MB:
        summary["growth_warning"] = (
            f"worker process-tree RSS grew by {growth_mb} MB, but RSS growth is not enforced on "
            "macOS when allocator pressure relief cannot return freed arenas"
        )
    if after["total_rss_mb"] > effective_max_end_mb:
        summary["failures"].append(
            f"worker process-tree RSS ended at {after['total_rss_mb']} MB "
            f"(> {effective_max_end_mb} MB effective cap for {process_count} process(es))"
        )
    if SMOKE_MEMORY_FORBID_PLAYWRIGHT_DRIVERS and after["playwright_driver_count"] > 0:
        summary["failures"].append(
            f"{after['playwright_driver_count']} Playwright driver process(es) still alive "
            f"after smoke ({after['playwright_driver_rss_mb']} MB RSS)"
        )

    return summary


def _docker_daemon_ping(timeout_seconds: float = 1.0) -> bool:
    """Return True only when the local Docker daemon responds to /_ping quickly."""
    import socket

    docker_host = os.environ.get("DOCKER_HOST", "")
    if docker_host.startswith("unix://"):
        socket_path = docker_host.removeprefix("unix://")
    elif docker_host:
        return False
    else:
        socket_path = "/var/run/docker.sock"

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout_seconds)
            sock.connect(socket_path)
            sock.sendall(b"GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n")
            return b"OK" in sock.recv(128)
    except Exception:
        return False


STALE_WORKFLOW_COUNT_ATTEMPTS = 3


async def _count_stale_workflows(client, namespace: str, query: str, *, sleep=asyncio.sleep) -> int:
    """Count running workflows with a bounded, jittered ResourceExhausted backoff.

    CountWorkflowExecutions spends the namespace's shared Visibility API budget,
    which production workers use too. The SDK's high-level count retries five
    times in quick succession; at fleet width that multiplies every throttled
    startup. Make at most three attempts and spread them instead.
    """
    from temporalio.api.workflowservice.v1 import CountWorkflowExecutionsRequest
    from temporalio.service import RPCError, RPCStatusCode

    for attempt in range(1, STALE_WORKFLOW_COUNT_ATTEMPTS + 1):
        try:
            response = await client.workflow_service.count_workflow_executions(
                CountWorkflowExecutionsRequest(namespace=namespace, query=query),
                retry=False,
                timeout=timedelta(seconds=5),
            )
            return response.count
        except RPCError as error:
            if error.status != RPCStatusCode.RESOURCE_EXHAUSTED or attempt == STALE_WORKFLOW_COUNT_ATTEMPTS:
                raise
            await sleep(random.uniform(1.0, 2.0**attempt))
    raise AssertionError("unreachable")


async def _terminate_stale_workflows():
    """Terminate all running Temporal workflows on the local task queue.

    Stale workflows from previous benchmark runs continue dispatching activities
    to the new worker, flooding the backend with 404s for deleted agents and
    consuming DB connections + LLM quota. Clearing them before a new run
    prevents cascading resource exhaustion.
    """
    try:
        from temporalio.client import Client

        from config import load_config
        from temporal_connection import apply_stack_temporal_namespace, temporal_connect_options

        # The stack's workflows live in the namespace scripts/run.sh routed it to.
        apply_stack_temporal_namespace()
        workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
        if not workspace:
            print("  ❌ CONDUCTOR_WORKSPACE_NAME not set — cannot derive task queue")
            return
        os.environ.setdefault("TEMPORAL_TASK_QUEUE", f"navi-agent-tasks-{workspace}")

        config = load_config()

        # Safety check: terminate workflows only when we can prove the queue is
        # worktree-scoped. Local Temporal, a worktree-derived queue (via
        # CONDUCTOR_WORKSPACE_NAME), or explicit ALLOW_TEMPORAL_CLEANUP=true all
        # qualify. Cloud Temporal with a shared queue does not — that could
        # nuke another worktree's live runs.
        temporal_addr = config.temporal.address
        is_local = any(h in temporal_addr for h in ("localhost", "127.0.0.1"))
        allow_cleanup = os.environ.get("ALLOW_TEMPORAL_CLEANUP", "").lower() == "true"
        is_worktree_scoped = bool(os.environ.get("CONDUCTOR_WORKSPACE_NAME"))
        if not is_local and not allow_cleanup and not is_worktree_scoped:
            print(
                f"  ⚠ Skipping workflow cleanup — Temporal address ({temporal_addr}) is not local, queue is not worktree-scoped, and ALLOW_TEMPORAL_CLEANUP is not set"
            )
            return

        task_queue = f"navi-agent-tasks-{workspace}"

        client = await Client.connect(
            config.temporal.address,
            **temporal_connect_options(
                config.temporal.address,
                config.temporal.namespace,
                config.temporal.api_key,
            ),
        )

        query = f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"'
        count = await _count_stale_workflows(client, config.temporal.namespace, query)
        if count == 0:
            print(f"  ✅ No stale workflows on {task_queue}")
            return

        print(f"  🧹 Terminating {count} stale workflow(s) on {task_queue}...")
        terminated = 0
        async for wf in client.list_workflows(query):
            try:
                handle = client.get_workflow_handle(wf.id, run_id=wf.run_id)
                await handle.terminate(reason="Pre-benchmark cleanup of stale workflows")
                terminated += 1
            except Exception:
                pass  # Already completed/terminated — safe to ignore
        print(f"  ✅ Terminated {terminated} stale workflow(s)")
    except Exception as e:
        print(f"  ⚠ Could not clean stale workflows: {e}")


async def _fail_stale_active_agents():
    """Mark any Agent rows stuck in ACTIVE for >30 min as FAILED.

    These are orphans from aborted prior runs — their workflow was terminated
    (or never finished) but the DB row was left ACTIVE. Without this cleanup,
    the backend's agent-scoped polling + realtime listeners keep firing on
    ghosts and the next smoke run sees confusing stats.

    Runs via `docker exec psql` against the worktree's DB container so no
    psycopg/asyncpg dependency is introduced. Skipped silently if the
    container isn't running (run.sh will start a fresh one).
    """
    import subprocess

    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace:
        return
    if not _docker_daemon_ping():
        print("  ⚠ Skipping stale ACTIVE agent cleanup — Docker daemon did not respond")
        return
    container = f"victoria-db-{workspace}"
    ps = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{container}$", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    if container not in ps.stdout:
        return

    sql = (
        'UPDATE "Agent" SET status = \'FAILED\', "updatedAt" = NOW() '
        "WHERE status = 'ACTIVE' AND \"createdAt\" < NOW() - INTERVAL '30 minutes' "
        "RETURNING id;"
    )
    try:
        result = subprocess.run(
            ["docker", "exec", container, "psql", "-U", "postgres", "-d", "victoria", "-t", "-A", "-c", sql],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            ids = [line for line in result.stdout.splitlines() if line.strip() and line[0].isalnum()]
            if ids:
                print(f"  🧹 Marked {len(ids)} stale ACTIVE agent(s) as FAILED")
            else:
                print("  ✅ No stale ACTIVE agents")
        else:
            print(f"  ⚠ Stale-agent SQL failed: {result.stderr.strip()}")
    except Exception as e:
        print(f"  ⚠ Could not run stale-agent cleanup: {e}")


async def _has_usable_anthropic_api_key_fallback(base_url: str) -> bool:
    """Mirror the backend's funded-fallback selection without probing the key.

    Credential health owns the live Anthropic request. The benchmark preflight
    owns runtime selection: either the shared ANTHROPIC_API_KEY is configured
    and clear of its out-of-credits cooldown, OR OpenRouter is configured so
    Claude Code can use the Anthropic-compatible gateway (same path as
    resolveClaudeCodeSandboxApiKey when the shared org is on cooldown).
    """
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{base_url}/api/integrations/compute-code/anthropic-key/cooldown",
                headers=headers,
                timeout=10.0,
            )
        if response.status_code != 200:
            return False
        availability = response.json()
        if not isinstance(availability, dict):
            return False
        if availability.get("configured") is True and availability.get("onCooldown") is False:
            return True
        return availability.get("openrouterConfigured") is True
    except Exception:
        return False


async def _check_compute_code_credentials(base_url: str) -> bool:
    """Check if a provider-typed compute token is available for code-agent benchmarks.

    The runtime code-agent path uses the workflow's current compute token and
    routes to Claude Code or Codex based on the token provider. If no user/pool
    token is available, Claude Code can still use the shared ANTHROPIC_API_KEY
    fallback as long as the backend has not put it on cooldown.
    """
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            params = {"tokenType": "gpt"} if _anthropic_family_excluded() else None
            resp = await client.get(
                f"{base_url}/api/integrations/compute-code/credentials/token",
                headers=headers,
                params=params,
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("type") in ("claude", "gpt") and bool(data.get("accessToken"))

        return await _has_usable_anthropic_api_key_fallback(base_url)
    except Exception:
        return False


async def _check_codex_harness_credentials(base_url: str) -> bool:
    """Codex harness requires a usable GPT compute token or the funded Azure Codex deployment.

    The funded Codex path is the backend's Azure deployment; GPT_API_KEY never
    reaches a Codex sandbox. The backend's code credential-availability plan
    (own login, shared login, then Azure unless backed off) is what a Codex
    session create leases, so it decides the funded fallback.
    """
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{base_url}/api/integrations/gpt-code/credentials/token",
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                if bool(data.get("accessToken")):
                    return True
            if not API_KEY:
                return False
            plan = await client.get(
                f"{base_url}/api/claude-code-session/credential-availability",
                headers={"X-API-Key": API_KEY},
                params={"user_id": _current_benchmark_user_id()},
                timeout=10.0,
            )
            return plan.status_code == 200 and plan.json().get("codex") is True
    except Exception:
        return False


async def _check_claude_code_credentials(base_url: str) -> bool:
    """Check whether Claude Code can actually create a code session.

    A GPT/Codex compute token is not sufficient for a task that explicitly calls
    ``spawn_claude_code_agent``. Prefer a live OAuth access token when present.
    When OAuth is absent, accept the shared ANTHROPIC_API_KEY only if the
    backend reports it configured and not on cooldown — that is the same funded
    fallback ``resolveClaudeCodeAuthEnvs`` uses inside E2B. Do not launch when
    both are missing; discovering an unfunded key mid-run burns the suite.

    Deploy's explicit credential-skip mode qualifies only user/pool tokens.
    Only the token route's 404 proves absence; other failures remain errors.
    """
    allow_credential_skip = os.environ.get("BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP", "").strip() == "1"
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{base_url}/api/integrations/claude-code/credentials/token",
                headers=headers,
                timeout=10.0,
            )
            if allow_credential_skip:
                if resp.status_code == 404:
                    return False
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict) or not isinstance(data.get("accessToken"), str) or not data["accessToken"].strip():
                    raise RuntimeError("Claude Code credential response is invalid")
                return True
            if resp.status_code == 200:
                data = resp.json()
                if bool(data.get("accessToken")):
                    return True
        return await _has_usable_anthropic_api_key_fallback(base_url)
    except Exception:
        if allow_credential_skip:
            raise
        return False


def cache_ratchet_failures(
    task_results: list[TaskResult],
    floors: dict[str, float] = PER_TASK_CACHE_HIT_RATCHET,
) -> list[tuple[str, str, float, float]]:
    """Return prompt-cache share floor violations, including missing telemetry.

    The share is cache_read / (cache_read + cache_creation + uncached input) over
    every cache-sequenced call (llm_usage.aggregate_prompt_cache_share). A run
    with no sequenced call has no cache telemetry and fails closed.
    """
    failures: list[tuple[str, str, float, float]] = []
    for result in task_results:
        if result.status == "SKIPPED":
            continue
        task_floor = floors.get(result.name)
        if task_floor is None or task_floor <= 0:
            continue
        lane_floor = route_cache_floor(result.name, result.prompt_cache_routes)
        floor = task_floor if lane_floor is None else lane_floor
        total = (
            result.prompt_cache_read_input_tokens
            + result.prompt_cache_creation_input_tokens
            + result.prompt_cache_uncached_input_tokens
        )
        if result.prompt_cache_call_count <= 0 or total <= 0 or lane_floor is None:
            failures.append((result.name, result.agent_id, 0.0, floor))
            continue
        share_pct = round(result.prompt_cache_read_input_tokens / total * 100, 1)
        if share_pct < floor:
            failures.append((result.name, result.agent_id, share_pct, floor))
    return failures


def enforce_cache_ratchets(task_results: list[TaskResult]) -> list[tuple[str, str, float, float]]:
    """Fail the benchmark when prompt-cache share regresses or its telemetry is absent.

    Claude Code's floor miss is built-in warn-only: it is reported as a RISK and returned, never a
    failure, whatever the environment. Every other task's miss exits 1.
    """
    failures = cache_ratchet_failures(task_results)
    hard_failures = []
    warn_only_failures = []
    for failure in failures:
        name, _agent_id, _hit_pct, _floor = failure
        if name in CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY_TASKS:
            warn_only_failures.append(failure)
        else:
            hard_failures.append(failure)

    if warn_only_failures:
        print("\n  ⚠ RISK: CACHE RATCHET WARN-ONLY (deploy-approved Claude Code cache telemetry floor missed):")
        for name, agent_id, hit_pct, floor in warn_only_failures:
            print(f"    - {name}: {hit_pct}% < {floor}% ratchet (not a pass of the floor; task outcome unchanged)")
            print(f"      cd agents && source venv/bin/activate && python benchmarks/agent_cache.py {agent_id}")

    if not hard_failures:
        return warn_only_failures

    print("\n  ❌ CACHE RATCHET FAILED (per-task prompt-cache share floor):")
    for name, _agent_id, hit_pct, floor in hard_failures:
        print(f"    - {name}: {hit_pct}% < {floor}% ratchet")
    print(
        "\n  Diagnose each failure with agent_cache.py to see per-LLM-call"
        "\n  read/write/hit% and find where the prefix fingerprint is drifting:"
    )
    for name, agent_id, _hit_pct, _floor in hard_failures:
        print(f"    cd agents && source venv/bin/activate && python benchmarks/agent_cache.py {agent_id}  # {name}")
    print(
        "\n  Fix the cache miss (e.g. unstable prefix hash, model mix,"
        "\n  claudeAuth fall-through) and re-run until hit% ≥ ratchet."
    )
    raise SystemExit(1)


AGENTCARD_SANDBOX_LOCK_FILENAME = "rose-agentcard-sandbox-benchmark.lock"
AGENTCARD_SANDBOX_DEFAULT_SLOTS = 2
AGENTCARD_SANDBOX_POLL_SECONDS = 1.0
# Waiters sleep poll * [1, 1 + JITTER) so lanes that started together do not
# poll in lockstep and let the same lane win every freed slot.
AGENTCARD_SANDBOX_POLL_JITTER = 0.5
# After releasing, a holder pauses for poll * HANDOFF (longer than any waiter's
# poll interval, including legacy 1s pollers) before its process can start the
# next sandbox task, so a back-to-back holder cannot re-take the slot ahead of
# lanes that were already waiting.
AGENTCARD_SANDBOX_RELEASE_HANDOFF = 2.0


def _agentcard_sandbox_slot_count() -> int:
    raw = os.environ.get("BENCHMARK_AGENTCARD_SLOTS", "").strip()
    if not raw:
        return AGENTCARD_SANDBOX_DEFAULT_SLOTS
    try:
        return max(1, int(raw))
    except ValueError as exc:
        raise ValueError(f"BENCHMARK_AGENTCARD_SLOTS must be an integer, got {raw!r}") from exc


def _agentcard_sandbox_slot_paths() -> list[Path]:
    """Slot 0 is the legacy single-lock path; slots 1..K-1 add a `.slot<N>` suffix."""
    legacy = Path(
        os.environ.get("BENCHMARK_AGENTCARD_LOCK_PATH") or Path(tempfile.gettempdir()) / AGENTCARD_SANDBOX_LOCK_FILENAME
    )
    extra = [legacy.with_name(f"{legacy.name}.slot{slot}") for slot in range(1, _agentcard_sandbox_slot_count())]
    return [legacy, *extra]


def _try_acquire_agentcard_slot(fds: list[int]) -> int | None:
    for slot, fd in enumerate(fds):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            continue
        return slot
    return None


@asynccontextmanager
async def _sandbox_agentcard_payment_lock(
    label: str = "",
    *,
    poll_seconds: float = AGENTCARD_SANDBOX_POLL_SECONDS,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    jitter: Callable[[], float] = random.random,
) -> AsyncIterator[int]:
    """Hold one of K host-wide AgentCard sandbox slots for one benchmark task.

    Why a limit at all: every Conductor workspace's isolated lane has its own
    Postgres/backend/worker, Stripe customers, and asserts only on its own
    card/transfer/intent, so overlapping lanes are correct. The one shared
    resource is AgentCard's org-wide API budget of 120 req/min; one lifecycle
    run makes ~42 org calls/min, so two concurrent runs fit and a third risks
    rate-limit failures. Hence `BENCHMARK_AGENTCARD_SLOTS` (default 2, min 1)
    counting slots instead of one host-wide mutex.

    Compatibility: slot 0 is exactly the legacy single-lock path
    (`BENCHMARK_AGENTCARD_LOCK_PATH` or `$TMPDIR/rose-agentcard-sandbox-benchmark.lock`),
    so workspaces still running the old code (which lock only that file) keep
    coordinating with new code. Slots 1..K-1 use the same path plus `.slot<N>`.

    flock is per open file description, so each acquire opens its own fds and
    holds the lock in this process until release. Yields the held slot index.
    """
    paths = _agentcard_sandbox_slot_paths()
    who = f" [{label}]" if label else ""
    started = time.monotonic()
    fds: list[int] = []
    held: int | None = None
    try:
        for path in paths:
            fds.append(os.open(path, os.O_CREAT | os.O_RDWR, 0o600))
        announced = False
        while (held := _try_acquire_agentcard_slot(fds)) is None:
            if not announced:
                print(
                    f"  ⏳ AgentCard sandbox{who}: waiting for AgentCard sandbox slot "
                    f"(all {len(paths)} held by other benchmark lanes; shared 120 req/min org budget) {paths[0]}",
                    flush=True,
                )
                announced = True
            await sleep(poll_seconds * (1 + AGENTCARD_SANDBOX_POLL_JITTER * jitter()))
        print(
            f"  🔒 AgentCard sandbox{who}: acquired slot {held} of {len(paths)} "
            f"after {time.monotonic() - started:.1f}s wait ({paths[held]})",
            flush=True,
        )
        yield held
    finally:
        if held is not None:
            fcntl.flock(fds[held], fcntl.LOCK_UN)
        for fd in fds:
            os.close(fd)
    # Reached only on a clean exit; an exception or cancellation propagates
    # out of the finally above without delaying teardown.
    await sleep(poll_seconds * AGENTCARD_SANDBOX_RELEASE_HANDOFF)


async def _run_with_sandbox_payment_lock(
    task: BenchmarkTask, runner: Callable[[], Awaitable[TaskResult]]
) -> TaskResult:
    if "agentcard-lifecycle-sandbox" in getattr(task, "tags", []):
        async with _sandbox_agentcard_payment_lock(getattr(task, "name", "")):
            return await runner()
    return await runner()


def _parallel_task_runners(
    tasks: list[BenchmarkTask],
    max_concurrency: int | None,
    runner: Callable[[BenchmarkTask], Awaitable[TaskResult]],
) -> list[Awaitable[TaskResult]]:
    """Build task runners with the configured batch concurrency.

    Isolated local stacks key browser-provider profiles by agent, so browser
    tasks consume ordinary batch slots and may overlap. Shared/prod stacks keep
    the legacy one-writer guard because their user profile is intentionally
    persistent across runs.
    """
    semaphore = (
        asyncio.Semaphore(max_concurrency) if max_concurrency is not None and max_concurrency < len(tasks) else None
    )
    isolated_browser_profiles = os.environ.get("BENCHMARK_ISOLATED_BROWSER_PROFILES", "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    browser_profile_writer = None if isolated_browser_profiles else asyncio.Semaphore(1)
    # The SMS supervisor is a per-user singleton: one phone, one SmsSession row,
    # one web_search fixture file. Two SMS tasks in flight together interleave
    # inbound texts on the same transcript, and each one's _reset_session wipes
    # the other's. Serialize them against each other; they still run alongside
    # non-SMS work.
    sms_surface = asyncio.Semaphore(1)
    # The cross-process lock is held by the task runner below. Keep a local
    # semaphore too so one batch does not spin many waiters on the file lock.
    payment_surface = asyncio.Semaphore(1)
    # The user's agent identity owns one inbox and one phone, and every browser
    # agent of that user is handed the codes that arrive there. Hosted-auth
    # lanes therefore run one at a time; other work overlaps. Run several
    # stacks side by side for parallelism: each stack mints its own identity.
    agent_inbox = asyncio.Semaphore(1)

    async def run_with_batch_limit(task: BenchmarkTask) -> TaskResult:
        if semaphore is None:
            return await runner(task)
        async with semaphore:
            return await runner(task)

    async def run_with_other_surface_limits(task: BenchmarkTask) -> TaskResult:
        if task.requires_browser_agent and browser_profile_writer is not None:
            # Acquire the resource-specific lock first so a queued browser task
            # does not consume a general slot that non-browser work can use.
            async with browser_profile_writer:
                return await run_with_batch_limit(task)
        # getattr: the parallel-scheduler test drives this with a minimal task
        # stub, and a missing runner just means the default agent runner.
        if getattr(task, "runner", "agent") == "sms":
            async with sms_surface:
                return await run_with_batch_limit(task)
        return await run_with_batch_limit(task)

    async def run_with_inbox_limit(task: BenchmarkTask) -> TaskResult:
        if auth_test_site.shares_agent_inbox(getattr(task, "environment", None)):
            async with agent_inbox:
                return await run_with_other_surface_limits(task)
        return await run_with_other_surface_limits(task)

    async def run_limited(task: BenchmarkTask) -> TaskResult:
        if "agentcard-lifecycle-sandbox" in getattr(task, "tags", []):
            async with payment_surface:
                return await run_with_inbox_limit(task)
        return await run_with_inbox_limit(task)

    return [run_limited(task) for task in tasks]


def _parallel_task_phases(
    tasks: list[BenchmarkTask],
) -> list[tuple[str, list[BenchmarkTask]]]:
    """Order exclusive tasks ahead of agent trees that may outlive a root.

    A timed-out task can be intentionally retained for diagnostics while one of
    its descendants continues working. Running a destructive fixture after the
    root future settles therefore is not isolated: the descendant can recreate
    shared rows during the fixture. Starting the exclusive phase first makes the
    clean-stack boundary real without sacrificing failed-tree diagnostics.
    Trajectory-recall tasks join it for the same reason: no sibling may finish
    and become a prior run while they search history.

    ``browser-biometrics-webdecoy`` stays exclusive even when
    ``BENCHMARK_ISOLATED_BROWSER_PROFILES`` is on: isolation protects saved
    browser state, but concurrent LLM-heavy siblings still stall FCaptcha PoW /
    pointer timing and produce the timeout-on-retry class.
    """
    exclusive_names = set(EXCLUSIVE_SHARED_DB_TASK_NAMES)

    def is_exclusive(task: BenchmarkTask) -> bool:
        # A sibling that finishes mid-run would become a newer prior trajectory.
        return task.name in exclusive_names or _reads_base_trajectory_history(task)

    exclusive = [task for task in tasks if is_exclusive(task)]
    parallel = [task for task in tasks if not is_exclusive(task)]
    return [("exclusive", exclusive), ("parallel", parallel)]


async def main_async(args):
    benchmark_wall_clock_backstop_seconds()  # Reject invalid limits before live setup.
    if args.list:
        print("\nBenchmark Tasks:")
        print(f"  {'Name':<25} {'Title':<35} {'Tags'}")
        print(f"  {'-' * 80}")
        list_all_tasks()
        return

    if args.compare:
        if len(args.compare) != 2:
            print("--compare requires exactly 2 file paths")
            sys.exit(1)
        compare_runs(args.compare[0], args.compare[1])
        return

    # Resolve base URL: --url > --prod > --port > error
    if args.url != DEFAULT_BASE_URL:
        # User explicitly passed --url — it takes priority
        base_url = args.url.rstrip("/")
        if args.prod:
            print("  ⚠ --prod and --url both set. Using --url value.")
    elif args.prod:
        base_url = PROD_BASE_URL
    elif args.port:
        base_url = f"http://localhost:{args.port}"
    else:
        print("ERROR: --port N is required for local runs.")
        print("Example: python benchmarks/run_benchmark.py --suite smoke --port 3001")
        sys.exit(1)

    _bind_backend_api_url(base_url)

    tasks = resolve_tasks(args)
    if not tasks:
        print("No tasks matched. Use --list to see available tasks.")
        sys.exit(1)
    if args.wmh_initial_state_file:
        if len(tasks) != 1 or len(task_names_from_args(args)) != 1:
            raise ValueError("--wmh-initial-state-file requires exactly one explicit --task")
        task = tasks[0]
        if task.world_model_mode != "simulate":
            raise ValueError("--wmh-initial-state-file requires a simulate-mode task")
        source_path = Path(args.wmh_initial_state_file).resolve()
        state = json.loads(source_path.read_text(encoding="utf-8"))
        task.wmh_initial_state = validate_wmh_initial_state(state, task.name)
        task._wmh_initial_state_source = str(source_path)
    if _force_show_passwords_mode():
        tasks = [task for task in tasks if task.name == AMAZON_AUTH_ASSISTANCE_TASK_NAME]
        if not tasks:
            print("--force-show-passwords only applies to the browser-agent Amazon auth benchmark.")
            sys.exit(1)
    _apply_benchmark_env_overrides(tasks)
    _apply_force_show_passwords_task_overrides(tasks)

    # Apply CLI row overrides to all tasks
    if args.row_start is not None or args.row_end is not None:
        for t in tasks:
            if args.row_start is not None:
                t.row_start = args.row_start
            if args.row_end is not None:
                t.row_end = args.row_end

    if args.timeout_seconds is not None:
        for t in tasks:
            t.timeout_seconds = args.timeout_seconds
        print(f"  🔧 timeout_seconds overridden to {args.timeout_seconds}s")

    # Apply CLI sub-agent count override (re-template {n} in prompt)
    if args.sub_agent_count is not None:
        for t in tasks:
            if t.sub_agent_count is None:
                continue
            apply_sub_agent_count(t, args.sub_agent_count)
            print(f"  🔧 {t.name}: sub_agent_count overridden to {args.sub_agent_count}")

    # Authenticate
    print("\n  Authenticating...")
    authenticated_jwt = False
    try:
        await authenticate()
        authenticated_jwt = True
        print("  ✅ Authenticated")
    except Exception as e:
        print(f"  ⚠ Auth failed ({e}), falling back to API key")

    # Pre-flight for local runs: clean stale workflows + DB agents, warm up edge functions.
    # Cleanup invariant: at most 1 of each service per worktree; no ACTIVE agent orphans
    # on the task queue this run will use. Belt-and-braces with scripts/pre-smoke-cleanup.sh
    # (which handles the process/container side); this block handles the Temporal + DB side.
    if not args.prod and base_url.startswith("http://localhost"):
        _verify_worker_queue_alignment()
        skip_stale_cleanup = os.environ.get("BENCHMARK_SKIP_STALE_CLEANUP", "").lower() == "true"
        if skip_stale_cleanup:
            print("  ⚠ Skipping stale workflow/agent cleanup (BENCHMARK_SKIP_STALE_CLEANUP=true)")
        else:
            try:
                await asyncio.wait_for(_terminate_stale_workflows(), timeout=30)
            except asyncio.TimeoutError:
                print("  ⚠ Temporal stale-workflow cleanup timed out after 30s; continuing")
            await _fail_stale_active_agents()
        await _warmup_edge_functions(base_url)
        claude_code_tasks_for_refresh = [t for t in tasks if t.requires_claude_code]
        # Deploy smoke may opt into credential SKIP for Claude Code tasks when
        # the pool is rate-limited/missing (BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP).
        # Fleet/cloud require-pass stays fail-closed and must not set that flag.
        allow_claude_code_credential_skip = (
            os.environ.get("BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP", "").strip() == "1"
        )
        await _refresh_local_compute_tokens_for_run(
            base_url,
            require_claude_code=bool(claude_code_tasks_for_refresh) and not allow_claude_code_credential_skip,
            tasks=tasks,
        )
        # Base-image dumps can freeze unusable Gmail OAuth rows; any local task
        # that must send email (message_person) needs a fresh credential overlay
        # or Connected Integrations never lists a from_email and the harness
        # fails before an email_send approval can fire.
        if any("message_person" in (t.expected_tools or []) for t in tasks):
            if not _sync_email_credentials():
                raise RuntimeError("Benchmark run could not refresh email credentials for message_person tasks")

    # Pre-flight: check provider-typed compute credentials for code-agent tests.
    # Default (fleet/cloud): missing Claude Code credentials after a required
    # refresh is a hard failure — never SKIP+PASS via cloudbench_result's
    # --allow-claude-code-credential-skip (epoch-2 daily masked
    # image-handling / files-in-sub-agents that way).
    # Deploy smoke sets BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP=1 so
    # infra-fix deploys are not blocked on Anthropic pool cooldowns; the
    # Claude Code tasks become the deploy-approved loud SKIP.
    skipped_claude_tasks: List[BenchmarkTask] = []
    claude_code_tasks = [t for t in tasks if t.requires_claude_code]
    allow_claude_code_credential_skip = os.environ.get("BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP", "").strip() == "1"
    if claude_code_tasks:
        has_claude_creds = await _check_claude_code_credentials(base_url)
        if not has_claude_creds:
            skipped_names = [t.name for t in claude_code_tasks]
            if allow_claude_code_credential_skip:
                print("  ⚠ Claude Code credentials unavailable — skipping: " + ", ".join(skipped_names))
                skipped_claude_tasks = claude_code_tasks
                tasks = [t for t in tasks if not t.requires_claude_code]
            else:
                raise RuntimeError(
                    "Claude Code credentials unavailable after compute-token refresh: " + ", ".join(skipped_names)
                )

    await _update_world_model_before_simulation(args)

    # Pre-flight: resolve each task's execution timeout.
    for t in tasks:
        if polar_wall_clock_disabled(t):
            budget = polar_browser_step_budget(t)
            t._resolved_timeout_seconds = 0
            print(f"  🧭 {t.name} → wall-clock disabled; browser step budget={budget if budget is not None else '—'}")
            continue
        t._resolved_timeout_seconds, note = resolve_task_execution_timeout(t, bootstrap=args.bootstrap)
        print(f"  ⏱  {t.name} → {t._resolved_timeout_seconds}s ({note})")

    # Start Fly.io log streaming
    fly_status = await start_fly_log_collector(backend_url=base_url)
    print(f"  📡 {fly_status}")
    is_private_realtime = "localhost" not in base_url and "127.0.0.1" not in base_url
    realtime_started = False
    if is_private_realtime and not authenticated_jwt:
        realtime_status = "supabase realtime frame collector disabled (prod private channels require JWT auth)"
    else:
        realtime_status = await start_supabase_realtime_collector(private=is_private_realtime)
        realtime_started = True
    print(f"  📡 {realtime_status}")

    task_names = task_names_from_args(args)
    suite_name = args.suite or (",".join(task_names) if task_names else "all")
    print(f"\n{'=' * 60}")
    print("  Agent Benchmark Harness")
    print(f"  URL:   {base_url}")
    print(f"  Suite: {suite_name}")
    print(f"  Tasks: {len(tasks)}{f' (+{len(skipped_claude_tasks)} skipped)' if skipped_claude_tasks else ''}")
    print(f"{'=' * 60}")

    # Run tasks — finally block ensures flyctl cleanup + results are always saved
    run = BenchmarkRun(suite=suite_name, base_url=base_url)
    parent_hub_run_id = os.environ.get("BENCHMARK_HUB_PARENT_RUN_ID", "").strip()
    if parent_hub_run_id:
        print(f"  📊 In-app Benchmark Hub: managed by parent run {parent_hub_run_id}")
    else:
        # Registration is a launch invariant: a benchmark agent must never be
        # created unless the Hub can already resolve this run. Local stacks
        # register against the stack under test (not prod) so a production
        # outage cannot deadlock /deploy of the outage fix. Final save uses
        # the same required contract below via results.py.
        from benchmarks.hub_upload import require_run_visible, resolve_hub_upload_url

        if not (os.environ.get("BENCHMARK_HUB_UPLOAD_URL") or "").strip():
            os.environ["BENCHMARK_HUB_UPLOAD_URL"] = resolve_hub_upload_url(base_url)
        os.environ.setdefault("BENCHMARK_HUB_API_KEY", API_KEY)
        os.environ["BENCHMARK_HUB_REQUIRED"] = "1"
        require_run_visible(
            {
                "run_id": run.run_id,
                "timestamp": run.timestamp,
                "suite": run.suite,
                "source": "benchmark-runner",
                "tasks": [{"name": task.name, "status": "starting"} for task in [*tasks, *skipped_claude_tasks]],
            }
        )
    checkpoint_source_mode = args.checkpoint_source_index is not None
    memory_gate_enabled = (
        suite_name == "smoke"
        and not args.prod
        and (base_url.startswith("http://localhost") or base_url.startswith("http://127.0.0.1"))
    )
    memory_baseline_before = await _stabilize_local_worker_memory(base_url, "before") if memory_gate_enabled else {}
    memory_before = _sample_local_worker_memory() if memory_gate_enabled else {"available": False, "reason": "disabled"}
    if memory_gate_enabled:
        if memory_before.get("available"):
            print(
                "  🧠 Worker memory before smoke: "
                f"{memory_before['total_rss_mb']} MB RSS, "
                f"playwright_drivers={memory_before['playwright_driver_count']}"
            )
        else:
            print(f"  ⚠ Worker memory sampling unavailable before smoke: {memory_before.get('reason')}")

    # Record skipped Claude Code tasks in results
    initial_credential_skips = tuple(_claude_code_credential_skip_result(t) for t in skipped_claude_tasks)
    for result in initial_credential_skips:
        result.graded_root_creation_outcome = "not_started"
        result.stop_metadata = {"runner": "benchmark_preflight", "admission": "not_started",
                                "reason": "claude_credential_unavailable"}
    run.task_results.extend(initial_credential_skips)

    # Live report card: a standardized progress snapshot emitted to stdout + the run's
    # context dir once per second (and once, forced, at the end). Purely observational —
    # every emit is wrapped so it can never break a benchmark run.
    from benchmarks.report_card import Infra, ReportCardEmitter, RunState, TaskCard, card_status, clean_source_sha

    _report_emitter = ReportCardEmitter(os.environ.get("BENCHMARK_CONTEXT_DIR", ".context"))
    _report_start = time.monotonic()
    _report_started_at = time.time()
    _report_source_sha = clean_source_sha(Path(__file__).resolve().parents[2])
    _report_finished_at: list[float] = []
    _wmh_evidence = _WMHEvidenceSnapshot()
    # name -> FIFO of live agent ids so k-repeats of the same task name each keep
    # their own deep link instead of overwriting one shared slot.
    # Entry to _run_reported_task is after every admission guard. Pending
    # futures can still be waiting for a semaphore or cross-process slot.
    # Task ownership also isolates repeated names and child agent callbacks.
    _admitted_tasks: dict[asyncio.Task, BenchmarkTask] = {}
    _admitted_agent_ids: dict[asyncio.Task, str] = {}
    # All created roots retain batch cleanup custody after their report row ends.
    _live_task_agent_ids: dict[str, list[str]] = {}
    _evaluated_task_results: dict[asyncio.Task, TaskResult] = {}
    _outcome_signatures: dict[str, str] = {}

    def _remember_live_agent(task_name: str, agent_id: str) -> None:
        if task_name and agent_id:
            _live_task_agent_ids.setdefault(task_name, []).append(agent_id)

    def _report_snapshot() -> RunState:
        try:
            peak_fly_raw = os.environ.get("BENCHMARK_PEAK_FLY_MACHINES")
            peak_fly_machines = int(peak_fly_raw) if peak_fly_raw else None
        except (TypeError, ValueError):
            peak_fly_machines = None
        task_world_model_modes = {t.name: t.world_model_mode for t in tasks if t.world_model_mode}
        per_task: list[TaskCard] = []
        evaluated_results = list(_evaluated_task_results.values())
        for r in [*run.task_results, *evaluated_results]:
            status = card_status(r.benchmark_status or ("SKIPPED" if r.status == "SKIPPED" else None), r.passed)
            per_task.append(
                TaskCard(
                    name=r.name,
                    status=status,
                    duration_s=r.duration_seconds,
                    cost_usd=(r.cost_cents / 100.0) if r.cost_cents is not None else None,
                    agent_url=durable_agent_frontend_url(r.agent_id) if r.agent_id else None,
                    agent_id=r.agent_id or None,
                    outcome_sha256=_outcome_signatures.get(r.agent_id),
                    llm_call_count=r.llm_call_count,
                    tree_agent_count=r.tree_agent_count,
                    tokens_in=r.tokens_in,
                    tokens_out=r.tokens_out,
                    world_model_mode=task_world_model_modes.get(r.name),
                    fast_mode=bool(getattr(r, "fast_mode_cache_enabled", False)),
                    infra_usd=_infra_usd_for_elapsed(r.duration_seconds) if r.duration_seconds is not None else None,
                )
            )
        # Evaluated occurrences retain their verdict during teardown; only
        # admitted, unevaluated executor occurrences are still running.
        for token, task in _admitted_tasks.items():
            if token in _evaluated_task_results:
                continue
            live_agent_id = _admitted_agent_ids.get(token)
            per_task.append(
                TaskCard(
                    name=task.name,
                    status="running",
                    agent_url=durable_agent_frontend_url(live_agent_id) if live_agent_id else None,
                    agent_id=live_agent_id or None,
                    world_model_mode=task_world_model_modes.get(task.name),
                )
            )
        elapsed = time.monotonic() - _report_start
        total_tasks = len(tasks) + len(skipped_claude_tasks)
        if not _report_finished_at and len(per_task) >= total_tasks \
                and all(t.status in ("passed", "failed", "skipped") for t in per_task):
            _report_finished_at.append(time.time())  # first snapshot with every verdict recorded
        wmh_usage = _wmh_evidence.refresh()
        return RunState(
            run_id=run.run_id,
            elapsed_s=elapsed,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
            total_tasks=total_tasks,
            source_sha=_report_source_sha,
            started_at=_report_started_at,
            finished_at=_report_finished_at[0] if _report_finished_at else None,
            task_names=[t.name for t in tasks] + [t.name for t in skipped_claude_tasks],
            per_task=per_task,
            # WMH grounding cost + tokens are only known when a WMH is served
            # (simulate/shadow); None for plain real runs so the card renders "—".
            wmh_grounding_usd=(
                float(wmh_usage["total_cost_usd"])
                if wmh_usage and wmh_usage.get("total_cost_usd") is not None
                else None
            ),
            wmh_tokens_in=(int(wmh_usage.get("input_tokens") or 0) if wmh_usage else None),
            wmh_tokens_out=(int(wmh_usage.get("output_tokens") or 0) if wmh_usage else None),
            # Whole-run infra cost = machine rate × wallclock (per-bench isolated
            # machine); per-task infra_usd above attributes it to each bench.
            infra_usd=_infra_usd_for_elapsed(elapsed),
            infra=Infra(peak_machines=peak_fly_machines) if peak_fly_machines is not None else None,
        )

    def _emit_report(*, force: bool = False) -> None:
        try:
            _report_emitter.maybe_emit(
                _report_snapshot(),
                force=force,
            )
        except Exception as exc:  # [REDACTED] must never fail the run
            print(f"  ⚠ report card emit failed: {exc}")

    # Live report card: a background ticker emits on a timer so the dashboard updates
    # DURING the run. The drain loop only emits on task-completion events, so a single
    # blocking task (or any long task) would otherwise leave the report screen blank
    # until the very end. Admission state keeps repeated task occurrences
    # distinct without treating pending scheduler waiters as active executors.

    _entered_task_futures: set[asyncio.Task] = set()
    _never_admitted_results: list[TaskResult] = list(initial_credential_skips)

    async def _run_reported_task(task: BenchmarkTask, **kwargs) -> TaskResult:
        # Before admission: nothing is created yet if the batch is cancelled here.
        if _reads_base_trajectory_history(task):
            await asyncio.to_thread(_prepare_base_trajectory_history, task, base_url, batch_started_at)
        # The owning task preserves repeated names and retains the evaluated
        # row until the coordinator replaces it with the final cleanup result.
        token = asyncio.current_task()
        assert token is not None
        _entered_task_futures.add(token)
        _admitted_tasks[token] = task
        registered_roots: set[str] = set()

        def remember_agent(task_name: str, agent_id: str) -> None:
            # Creation can run in a child task; retain the admitted owner.
            # Cleanup owns every root, including composite or interrupted runs.
            _remember_live_agent(task_name, agent_id)
            if agent_id:
                registered_roots.add(agent_id)
            custody = _task_root_custody.get()
            role = next((root["role"] for root in (custody or {}).get("roots", []) if root["root_agent_id"] == agent_id), None)
            if agent_id and role != "fixture_first_run":
                _admitted_agent_ids.setdefault(token, agent_id)

        def retire_verified_sms_roots(receipt: dict | None) -> None:
            if not isinstance(receipt, dict) or receipt.get("verified") is not True:
                return
            retired = set(receipt.get("owned_agent_ids", receipt.get("root_agent_ids", []))) & registered_roots
            kept = [aid for aid in _live_task_agent_ids.get(task.name, []) if aid not in retired]
            if kept:
                _live_task_agent_ids[task.name] = kept
            else:
                _live_task_agent_ids.pop(task.name, None)

        async def evaluated(result: TaskResult) -> None:
            from benchmarks.outcome_publication import prepare, wait_for_publication

            contract = cloud_batch_cleanup.contract()
            pending = None
            try:
                pending = prepare(result, contract[0].parent, contract[1]) if contract and result.agent_id else None
            except (OSError, ValueError) as exc:
                print(f"  ⚠ outcome acknowledgment preparation unavailable: {type(exc).__name__}")
            if pending:
                _outcome_signatures[result.agent_id] = pending[1]
            _evaluated_task_results[token] = result
            _emit_report(force=True)
            await wait_for_publication(pending)

        try:
            sms_options = {}
            if getattr(task, "runner", "agent") == "sms":
                sms_options["other_task_roots"] = lambda: {aid for ids in _live_task_agent_ids.values()
                                                          for aid in ids if aid not in registered_roots}
            result = await run_single_task(
                base_url, task, on_agent_created=remember_agent, on_task_evaluated=evaluated,
                **sms_options, **kwargs
            )
            metadata = getattr(result, "stop_metadata", None)
            if isinstance(metadata, dict) and metadata.get("runner") == "sms":
                retire_verified_sms_roots(metadata.get("owned_cleanup_receipt"))
            if token not in _evaluated_task_results:
                await evaluated(result)
            return result
        except asyncio.CancelledError as exc:
            retire_verified_sms_roots(getattr(exc, "owned_cleanup_receipt", None))
            raise
        finally:
            _admitted_tasks.pop(token, None)
            _admitted_agent_ids.pop(token, None)

    async def _report_ticker() -> None:
        try:
            while True:
                await asyncio.sleep(1)
                _emit_report()
        except asyncio.CancelledError:
            pass

    owned_batch_cleanup = cloud_batch_cleanup.contract() is not None
    batch_started_at = datetime.now(timezone.utc)
    if owned_batch_cleanup:
        _begin_interrupt_cleanup()
    _report_ticker_task = asyncio.create_task(_report_ticker())
    _emit_report(force=True)
    try:
        if checkpoint_source_mode:
            if len(tasks) != 1:
                raise ValueError("--checkpoint-source-index requires exactly one task")
            if args.checkpoint_source_price_limit_cents is not None:
                tasks[0].price_limit_cents = args.checkpoint_source_price_limit_cents
            result = await _run_with_sandbox_payment_lock(
                tasks[0],
                lambda: _run_reported_task(
                    tasks[0],
                    keep_failed_agents=True,
                    checkpoint_source_index=args.checkpoint_source_index,
                    checkpoint_source_boundary=args.checkpoint_source_boundary,
                    checkpoint_source_out=Path(args.checkpoint_source_out),
                    checkpoint_tree_out=Path(args.checkpoint_tree_out) if args.checkpoint_tree_out else None,
                ),
            )
            run.task_results.append(result)
            _evaluated_task_results.pop(asyncio.current_task(), None)
        elif args.parallel:
            max_concurrency = args.max_concurrency
            if max_concurrency is None and args.prod:
                max_concurrency = int(os.environ.get("BENCHMARK_PROD_MAX_CONCURRENCY", "2"))
            if max_concurrency is not None and max_concurrency < 1:
                raise ValueError("--max-concurrency must be >= 1")

            # Destructive shared-DB fixtures must never overlap any agent tree.
            # Run them before ordinary roots can leave retained descendants.
            phases = _parallel_task_phases(tasks)
            exclusive_db_tasks = phases[0][1]
            parallel_batch = phases[1][1]
            if exclusive_db_tasks:
                names = ", ".join(t.name for t in exclusive_db_tasks)
                print(
                    f"\n  Running {len(exclusive_db_tasks)} exclusive task(s) before the parallel phase: {names}"
                )

            if max_concurrency is None or max_concurrency >= len(parallel_batch):
                print(f"\n  Running {len(parallel_batch)} tasks in parallel...")
            else:
                print(f"\n  Running {len(parallel_batch)} tasks in parallel (max_concurrency={max_concurrency})...")

            async def run_parallel_task(task: BenchmarkTask) -> TaskResult:
                return await _run_with_sandbox_payment_lock(
                    task,
                    lambda: _run_reported_task(
                        task,
                        keep_failed_agents=args.keep_failed_agents,
                    ),
                )

            pending_results: dict[asyncio.Task, BenchmarkTask] = {}
            pending: set[asyncio.Task] = set()
            try:
                for task in exclusive_db_tasks:
                    print(f"\n  Running exclusive task serially: {task.name}")
                    result = await _run_with_sandbox_payment_lock(
                        task,
                        lambda: _run_reported_task(
                            task,
                            keep_failed_agents=args.keep_failed_agents,
                        ),
                    )
                    run.task_results.append(result)
                    _evaluated_task_results.pop(asyncio.current_task(), None)
                    _emit_report()

                task_runners = _parallel_task_runners(
                    parallel_batch,
                    max_concurrency,
                    run_parallel_task,
                )
                pending_results = {
                    asyncio.create_task(runner, name=f"benchmark-{task.name}"): task
                    for task, runner in zip(parallel_batch, task_runners)
                }
                pending = set(pending_results)
                while pending:
                    done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                    for task_future in done:
                        task = pending_results[task_future]
                        try:
                            result = task_future.result()
                        except BaseException as exc:
                            run.task_results.append(
                                TaskResult(
                                    name=task.name,
                                    passed=False,
                                    agent_id="",
                                    status="ERROR",
                                    benchmark_status="ERROR",
                                    progress_score=0,
                                    duration_seconds=0,
                                    cost_cents=0,
                                    message_count=0,
                                    failure_reason=str(exc),
                                )
                            )
                        else:
                            run.task_results.append(result)
                        _evaluated_task_results.pop(task_future, None)
                    _emit_report()
            except asyncio.CancelledError:
                for task_future in pending:
                    task_future.cancel()
                cancelled = await asyncio.gather(*pending, return_exceptions=True)
                for task_future, result in zip(pending, cancelled):
                    task = pending_results[task_future]
                    if isinstance(result, TaskResult):
                        run.task_results.append(result)
                    else:
                        cancelled_result = TaskResult(
                                name=task.name,
                                passed=False,
                                agent_id="",
                                status="CANCELLED",
                                benchmark_status="CANCELLED",
                                progress_score=0,
                                duration_seconds=0,
                                cost_cents=0,
                                message_count=0,
                                failure_reason=f"Benchmark interrupted before task produced logs: {result}",
                        )
                        if task_future not in _entered_task_futures:
                            cancelled_result.graded_root_creation_outcome = "not_started"
                            cancelled_result.stop_metadata = {"runner": "benchmark_coordinator", "admission": "not_started", "occurrence_index": list(pending_results).index(task_future)}
                            _never_admitted_results.append(cancelled_result)
                        run.task_results.append(cancelled_result)
                raise
        else:
            for task in tasks:
                result = await _run_with_sandbox_payment_lock(
                    task,
                    lambda: _run_reported_task(
                        task,
                        keep_failed_agents=args.keep_failed_agents,
                    ),
                )
                run.task_results.append(result)
                _evaluated_task_results.pop(asyncio.current_task(), None)
                _emit_report()
    finally:
        _report_ticker_task.cancel()
        _evaluated_task_results.clear()
        _emit_report(force=True)
        fly_total = await stop_fly_log_collector()
        print(f"\n  📡 Fly.io log stream stopped ({fly_total} lines captured)")
        if realtime_started:
            realtime_total = await stop_supabase_realtime_collector()
            print(f"  📡 Supabase realtime frame stream stopped ({realtime_total} frames captured)")

        if memory_gate_enabled:
            memory_baseline_after = await _stabilize_local_worker_memory(base_url, "after")
            memory_after = _sample_local_worker_memory()
            run.memory_summary = _build_smoke_memory_summary(
                memory_before,
                memory_after,
                baseline={
                    "before": memory_baseline_before,
                    "after": memory_baseline_after,
                },
            )
            if memory_after.get("available"):
                growth = run.memory_summary.get("growth_mb")
                print(
                    "  🧠 Worker memory after smoke: "
                    f"{memory_after['total_rss_mb']} MB RSS "
                    f"(growth={growth:+.1f} MB), "
                    f"playwright_drivers={memory_after['playwright_driver_count']}"
                )
            else:
                print(f"  ⚠ Worker memory sampling unavailable after smoke: {memory_after.get('reason')}")

        await _finalize_owned_batch_and_save_run(
            base_url,
            run,
            _live_task_agent_ids,
            owned_batch_cleanup=owned_batch_cleanup,
            retrieval_audit=_wmh_evidence.finalize,
            never_admitted_results=tuple(_never_admitted_results),
        )

    # Print summary
    s = run.summary
    skipped_str = f", {s['skipped']} skipped" if s.get("skipped") else ""
    print(f"\n{'=' * 60}")
    print(f"  RESULTS: {s['passed']}/{s['total']} passed ({s['pass_rate']:.0%}{skipped_str})")
    print(f"  Cost: {s['total_cost_cents']:.1f}c | Duration: {s['total_duration_seconds']:.0f}s")

    # Cache hit rate summary across all tasks
    agg_cache_read = sum(r.cache_read_input_tokens for r in run.task_results)
    agg_cache_write = sum(r.cache_creation_input_tokens for r in run.task_results)
    agg_cache_total = agg_cache_read + agg_cache_write
    agg_cache_pct = round(agg_cache_read / agg_cache_total * 100, 1) if agg_cache_total > 0 else 0.0
    if agg_cache_total > 0:
        print(f"  Cache: read={agg_cache_read} write={agg_cache_write} hit={agg_cache_pct}%")
    memory_failures = (run.memory_summary or {}).get("failures", [])
    if run.memory_summary:
        growth = run.memory_summary.get("growth_mb")
        after = run.memory_summary.get("after", {})
        if growth is not None and after.get("available"):
            print(f"  Memory: worker RSS={after['total_rss_mb']} MB growth={growth:+.1f} MB")
    print(f"{'=' * 60}")

    if memory_failures:
        print("\n  ❌ MEMORY RATCHET FAILED (local smoke worker process tree):")
        for failure in memory_failures:
            print(f"    - {failure}")
        print(
            "\n  Inspect the saved run's memory_summary.processes and check for child"
            "\n  processes retained after browser-smoke, especially Playwright drivers."
        )
        sys.exit(1)

    enforce_cache_ratchets(run.task_results)

    # CI mode: exit non-zero if any task failed or if an unapproved task was
    # skipped. Claude Code credential-unavailable skips are explicitly permitted.
    if args.ci and _ci_should_fail(s, run.task_results):
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Agent Benchmark Harness")
    parser.add_argument("--list", action="store_true", help="List all benchmark tasks")
    parser.add_argument(
        "--task",
        action="append",
        default=[],
        help="Run one or more explicit task names. Repeatable; comma-separated names are also accepted.",
    )
    parser.add_argument(
        "--suite",
        type=str,
        help="Run tasks matching a tag (basic, browser, auth, auth-anon, auth-cookie, claude-code, attachment, for-each, outreach, all)",
    )
    parser.add_argument(
        "--url",
        type=str,
        default=DEFAULT_BASE_URL,
        help=f"Base API URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar="FILE",
        help="Compare two result files",
    )
    parser.add_argument(
        "--parallel",
        action="store_true",
        help="Run tasks concurrently instead of sequentially",
    )
    parser.add_argument(
        "--max-concurrency",
        type=int,
        default=None,
        help="Maximum concurrent benchmark tasks when --parallel is set. "
        "Defaults to BENCHMARK_PROD_MAX_CONCURRENCY or 2 for --prod; otherwise unbounded.",
    )
    parser.add_argument(
        "--ci",
        action="store_true",
        help="CI mode: exit with non-zero status if any task fails",
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="Bootstrap timeout history: use tasks.json timeout_seconds as the "
        "per-task ceiling even without history. Passed runs still record "
        "to the corpus. Use until every task has ≥5 passes, then drop this flag.",
    )
    parser.add_argument(
        "--row-start",
        type=int,
        default=None,
        help="Override task row_start — slice CSV attachments starting at this 1-indexed data row",
    )
    parser.add_argument(
        "--row-end",
        type=int,
        default=None,
        help="Override task row_end — slice CSV attachments ending at this 1-indexed data row (inclusive)",
    )
    parser.add_argument(
        "--sub-agent-count",
        type=int,
        default=None,
        help="Override sub_agent_count — substitutes {n} in prompt for load-test tasks",
    )
    parser.add_argument(
        "--exclude-task",
        action="append",
        default=[],
        help="Exclude a benchmark task by name. Repeatable; comma-separated names are also accepted.",
    )
    parser.add_argument(
        "--keep-failed-agents",
        action="store_true",
        help="Do not delete failed/cancelled benchmark agents after log collection. "
        "Useful for local diagnostic wrappers.",
    )
    parser.add_argument(
        "--keep-agents",
        action="store_true",
        help="Do not delete benchmark agents after log collection, including passed runs. "
        "Useful when a frontend link must remain viewable after the run.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=None,
        help="Diagnostic override for selected task timeouts; does not modify tasks.json.",
    )
    parser.add_argument(
        "--world-model-mode",
        choices=["real", "shadow", "simulate"],
        default=None,
        help="Set BENCHMARK_WORLD_MODEL_MODE for tool execution adapters. "
        "real runs live provider boundaries, shadow compares live provider boundaries with WMH predictions, "
        "simulate routes provider boundaries and specialized explore/browser/code subagents to WMH; "
        "root and general-purpose loops still run.",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Alias for --world-model-mode simulate. Root and general-purpose loops stay real; "
        "provider boundaries and specialized explore/browser/code subagents use WMH.",
    )
    parser.add_argument(
        "--wmh-eval",
        action="store_true",
        help="After each task finalizes its trace archive, run WMH open-loop fidelity scoring "
        "and store prediction accuracy in the run JSON.",
    )
    parser.add_argument(
        "--world-model-url",
        type=str,
        default=None,
        help="WMH server base URL for benchmark simulation/evaluation.",
    )
    parser.add_argument(
        "--world-model-name",
        type=str,
        default=None,
        help="WMH model name for benchmark simulation/evaluation.",
    )
    parser.add_argument(
        "--world-model-session-id",
        type=str,
        default=None,
        help="Existing WMH session id for simulate/shadow tool execution.",
    )
    parser.add_argument(
        "--wmh-initial-state-file",
        help="Override one simulate-mode task's catalog WHM initial state with an EnvState JSON file.",
    )
    parser.add_argument(
        "--anon",
        action="store_true",
        help="For minted-auth benchmarks, start without saved auth by disabling existing "
        "SteelSessionAuth/CookieBundle rows for the target realm.",
    )
    parser.add_argument(
        "--force-show-passwords",
        action="store_true",
        help="With --anon, keep seeded saved password refs visible while disabling real Steel/cookie auth. "
        "Used by the Amazon bad-auth assistance benchmark.",
    )
    parser.add_argument(
        "--checkpoint-source-index",
        type=int,
        default=None,
        help="Run one benchmark until this root message index exists, pause it, and export checkpoint source JSON.",
    )
    parser.add_argument(
        "--checkpoint-source-boundary",
        choices=["message-index", "for-each-finished"],
        default="message-index",
        help=(
            "Optional earlier durable source boundary for checkpoint export. "
            "for-each-finished pauses at the first finished spawn_general_purpose_agent_for_each row."
        ),
    )
    parser.add_argument(
        "--checkpoint-source-price-limit-cents",
        type=int,
        default=None,
        help="Override the source agent price limit while generating a checkpoint source transcript.",
    )
    parser.add_argument(
        "--checkpoint-source-out",
        type=str,
        default=None,
        help="Source JSON output path for --checkpoint-source-index.",
    )
    parser.add_argument(
        "--checkpoint-tree-out",
        type=str,
        default=None,
        help="Optional tree JSON output path for --checkpoint-source-index.",
    )
    parser.add_argument(
        "--harness",
        choices=["rose", "codex"],
        default=None,
        help="Override benchmark harness (rose=Temporal agent workflow, codex=Codex E2B orchestrator). "
        "Also set via BENCHMARK_HARNESS env.",
    )
    target_group = parser.add_mutually_exclusive_group()
    target_group.add_argument(
        "--prod",
        action="store_true",
        help=f"Run against production ({PROD_BASE_URL})",
    )
    target_group.add_argument(
        "--port",
        type=int,
        default=None,
        help="Run against localhost on this port (e.g. --port 3001)",
    )
    args = parser.parse_args()

    if args.keep_agents:
        os.environ["BENCHMARK_KEEP_AGENTS"] = "true"
        args.keep_failed_agents = True

    if not args.list and not args.compare and not task_names_from_args(args) and not args.suite:
        parser.print_help()
        sys.exit(1)

    if args.force_show_passwords and not args.anon:
        parser.error("--force-show-passwords requires --anon")
    if args.timeout_seconds is not None and args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.checkpoint_source_index is not None:
        if args.checkpoint_source_index < 0:
            parser.error("--checkpoint-source-index must be non-negative")
        if args.checkpoint_source_price_limit_cents is not None and args.checkpoint_source_price_limit_cents <= 0:
            parser.error("--checkpoint-source-price-limit-cents must be positive")
        if not args.task:
            parser.error("--checkpoint-source-index requires --task")
        if args.suite or args.parallel:
            parser.error("--checkpoint-source-index only supports one --task, not suites or --parallel")
        if not args.checkpoint_source_out:
            parser.error("--checkpoint-source-out is required with --checkpoint-source-index")
    elif args.checkpoint_source_out or args.checkpoint_tree_out or args.checkpoint_source_price_limit_cents:
        parser.error(
            "--checkpoint-source-out/--checkpoint-tree-out/--checkpoint-source-price-limit-cents "
            "require --checkpoint-source-index"
        )

    if args.anon:
        _apply_anon_benchmark_mode(force_show_passwords=args.force_show_passwords)
    if args.harness:
        os.environ["BENCHMARK_HARNESS"] = args.harness
    _apply_world_model_cli_env(args, parser)

    try:
        asyncio.run(main_async(args))
    finally:
        _finalize_interrupt_cleanup_status()


if __name__ == "__main__":
    main()
