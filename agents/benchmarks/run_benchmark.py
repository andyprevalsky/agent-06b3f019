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
import csv
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

import httpx

# Add parent dir to path so we can import from agents/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from benchmarks.benchmark_tasks import (
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
from benchmarks.live_fixtures import LIVE_FIXTURE_NAMES, resolve_live_fixtures
from benchmarks.llm_usage import aggregate_repeatable_cache_usage, aggregate_usage_items
from benchmarks.local import manifest_database_url
from benchmarks.logs import (
    collect_logs,
    collect_tree_messages,
    load_env_var,
    start_fly_log_collector,
    start_supabase_realtime_collector,
    stop_fly_log_collector,
    stop_supabase_realtime_collector,
    subscribe_supabase_realtime_agent,
)
from benchmarks.phone_callee import (
    PhoneCalleeSession,
    callee_check_failures,
    missing_call_findings,
    phone_search_text,
    resolve_callee_prompt,
)
from benchmarks.realtime_monitor import SupabaseRealtimeSmokeMonitor
from benchmarks.results import BenchmarkRun, TaskResult, compare_runs
from benchmarks.timeout_history import (
    InsufficientHistoryError,
)
from benchmarks.timeout_history import (
    get_timeout as _history_get_timeout,
)
from benchmarks.timeout_history import (
    summary as _history_summary,
)
from benchmarks.world_model_harness import evaluate_archive_with_world_model, update_world_model_for_simulation
from domains.set_plan.config import (
    PLANNER_ACTIVITY_MAX_ATTEMPTS,
    PLANNER_ACTIVITY_TIMEOUT_SECONDS,
)
from tests.e2e.test_helpers import (
    authenticate,
)

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
# Tasks whose fixtures destructively mutate shared benchmark DB state. The
# parallel scheduler runs these serially before starting any ordinary task so a
# retained failed agent tree cannot mutate their fixtures. Each fixture must
# also restore its state.
EXCLUSIVE_SHARED_DB_TASK_NAMES = {
    GREP_EXPLORE_STRESS_TASK_NAME,
    AMAZON_PASSKEY_TASK_NAME,
    BIOMETRICS_WEBDECOY_TASK_NAME,
}
USER_DATA_PROD_GREP_TASK_NAME = "user-data-prod-grep"
MESSAGE_PERSON_TASK_NAME = "message-person"
MESSAGE_PERSON_AGENT_SMS_TASK_NAME = "message-person-agent-sms"
USER_DATA_PROD_DOCUMENT_SOURCES = {"chatgpt", "claude", "apple_notes", "obsidian"}
USER_DATA_PROD_CHECKLIST_KEYS = {"provider_validation_checklist", "provider_verification_checklist"}
GREP_BASE_SNAPSHOT_ENV = "BENCHMARK_GREP_BASE_SNAPSHOT"
PLAID_TRANSACTION_BENCHMARK_TASK_NAMES = {
    "plaid-transactions-monthly-spend",
    "plaid-transactions-doordash-count",
    "plaid-transactions-dead-subscriptions",
}
MINTED_AGENT_ACCOUNT_X_AUTH_HINT = (
    "If X asks you to sign in or create an account first, use the minted email in auth options "
    "when an email address is accepted. Click controls like 'Use email instead' when they are available. "
    "Do not choose the initial 'Continue with phone' or 'Sign up with Phone' path; if X opens a phone-number "
    "field before you have tried the email route, go back and find the email route instead. "
    "Use the minted AgentPhone only if X explicitly requires phone/SMS auth after the email route. "
    "If X shows 'An unexpected error occurred', treats the phone number as invalid, or fails to send an SMS, "
    "stop and report that as a terminal phone-auth blocker instead of retrying alternate phone formats."
)
AMAZON_AUTH_ASSISTANCE_TASK_NAME = "browser-agent"
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
AGENT_PAYMENT_PRODUCTION_TASK_NAME = "agent-payment-production-abandonment"
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
PURCHASE_KYC_GATE_TASK_NAME = "gate-kyc-card-mint"
SOURCE_CONNECT_GATE_TASK_NAME = "gate-source-connect-gmail"
PURCHASE_SUBSCRIPTION_GATE_USER_ID = "00000000-0000-4000-8000-000000000102"
PURCHASE_KYC_GATE_USER_ID = "00000000-0000-4000-8000-000000000103"
SOURCE_CONNECT_GATE_USER_ID = "00000000-0000-4000-8000-000000000104"
# Repeatable-cache baselines from local smoke run
# 4657d9e8-6c05-48c2-bc20-1acd0513728a. The metric groups by authoritative
# agent identity + call site and excludes one-shot calls. Per the one-way
# ratchet policy, each qualifying task moved up by one 5-point increment:
# spawn 40.7% (20 -> 25), parallel 47.6% (25 -> 30), browser 51.0% (35 -> 40).
# Claude Code observed 47.5%, exactly the 45% + 2.5% trigger, so strict
# "more than" leaves its 40% floor unchanged.
PER_TASK_CACHE_HIT_RATCHET = {
    "chat-mode": 0.0,
    "spawn-sub-agents": 25.0,
    "parallel-tool-calls": 30.0,
    "claude-code-agent": 40.0,
    "browser-smoke": 40.0,
}
GATE_FIXTURE_TASK_MODES = {
    PURCHASE_SUBSCRIPTION_GATE_TASK_NAME: "purchase-subscription",
    PURCHASE_KYC_GATE_TASK_NAME: "purchase-kyc",
    SOURCE_CONNECT_GATE_TASK_NAME: "source-connect",
}
GATE_FIXTURE_TASK_USER_IDS = {
    PURCHASE_SUBSCRIPTION_GATE_TASK_NAME: PURCHASE_SUBSCRIPTION_GATE_USER_ID,
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
    """Return the X post benchmark prompt with auth guidance for fresh profiles."""
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


def _resolved_fast_mode_cache(task: BenchmarkTask) -> Optional[bool]:
    """Resolve Fast Mode without overriding a task's side-effect safety contract."""
    if task.fast_cache == "off":
        return False
    if task.fast_cache == "on":
        return True
    return _benchmark_env_bool("BENCHMARK_FAST_MODE_CACHE")


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
        return sequence[observed_count] if observed_count < len(sequence) else None
    return task.expected_attention_kind


def _attention_request_matches_task(
    task: BenchmarkTask,
    req: dict,
    observed_count: int = 0,
) -> bool:
    if task.expected_gate:
        return _gate_request_matches_task(task, req)
    alternatives = getattr(task, "expected_attention_kind_any_of", [])
    if alternatives:
        return observed_count == 0 and _attention_request_kind(req) in alternatives
    expected_kind = _expected_attention_kind(task, observed_count)
    if not expected_kind:
        return True
    return _attention_request_kind(req) == expected_kind


def _should_auto_approve_attention(task: BenchmarkTask, req: dict) -> bool:
    return not (
        task.agentcard_setup_action == "complete"
        and _attention_request_kind(req) == "agentcard_user_cardholder_onboarding_required"
    )


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
    expected = task.expected_gate or {}
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
        return "https://roselabs.ai"
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
    return "https://roselabs.ai"


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


def _normalize_receipt_items(receipt: dict) -> dict:
    out = {}
    for item in receipt.get("lineItems") or receipt.get("line_items") or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        out[name] = {
            "image_url": item.get("imageUrl")
            or item.get("image_url")
            or item.get("productImageUrl")
            or item.get("product_image_url"),
            "unit_price_cents": item.get("unitPriceCents") or item.get("unit_price_cents"),
            "quantity": item.get("quantity"),
            "line_total_cents": item.get("lineTotalCents") or item.get("line_total_cents"),
        }
    return out


def _normalize_receipt_fees(receipt: dict) -> dict:
    out = {}
    for fee in receipt.get("fees") or []:
        if not isinstance(fee, dict):
            continue
        label = fee.get("label") or fee.get("name")
        if isinstance(label, str) and label:
            out[label.lower()] = fee.get("amountCents") or fee.get("amount_cents")
    return out


def _receipt_amount(receipt: dict, camel_key: str) -> int | None:
    snake_key = "".join([f"_{c.lower()}" if c.isupper() else c for c in camel_key]).lstrip("_")
    value = receipt.get(camel_key)
    return value if value is not None else receipt.get(snake_key)


def _validate_payment_receipt(task: BenchmarkTask, req: dict) -> Optional[str]:
    expected = task.expected_payment_receipt
    if not expected:
        return None
    receipt = _payment_receipt_from_attention_request(req)
    if not receipt:
        return "missing requestPaymentCard metadata"

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
    if "merchant" in expected and receipt.get("merchant") != expected.get("merchant"):
        return f"merchant mismatch: expected {expected.get('merchant')}, got {receipt.get('merchant')}"
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
        actual = actual_items.get(name)
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
        label = expected_fee.get("label", "").lower()
        actual_fee = actual_fees.get(label)
        if actual_fee is None and label == "tax":
            actual_fee = next(
                (amount for actual_label, amount in actual_fees.items() if actual_label.startswith("tax (")),
                None,
            )
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
        if expected_value != actual_value:
            return f"{path} mismatch: expected {expected_value!r}, got {actual_value!r}"
        return None

    return compare(expected, actual, "payment_lifecycle")


CLAUDE_CODE_CREDENTIAL_SKIP_REASON = (
    "Claude Code credentials unavailable: no synced Claude token and no available pool token"
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
    skipped = summary.get("skipped", 0)
    if skipped <= 0:
        return False
    if task_results is None:
        return True
    skipped_results = [result for result in task_results if result.status == "SKIPPED"]
    return any(not _is_permitted_claude_code_skip(result) for result in skipped_results)


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


def _evaluate_agent_payment_result(data: dict) -> tuple[bool, str | None]:
    text = _agent_data_search_text(data)
    if "payment confirmed" not in text:
        return False, "agent did not report the test payment confirmation page"
    if "order" not in text:
        return False, "agent did not report the confirmation order id"
    return True, None


async def _evaluate_phone_call_task(
    task: BenchmarkTask,
    data: dict,
    callee: PhoneCalleeSession,
) -> tuple[bool, str | None]:
    """Two-sided phone verification: agent-side findings + callee-side analysis."""
    pinned_findings = _flatten_pinned_call_findings(task.pinned_facts)
    expected_findings = [*(task.expected_call_findings or []), *pinned_findings]
    missing = missing_call_findings(expected_findings, phone_search_text(data))
    if missing:
        return False, f"agent output missing pinned/expected call findings: {missing}"
    final_missing = missing_call_findings(task.expected_final_findings or [], phone_final_result_text(data))
    if final_missing:
        return False, f"final output missing expected returned findings: {final_missing}"
    if task.callee_checks:
        try:
            structured = await callee.fetch_callee_structured_data()
        except Exception as exc:
            return False, f"failed to fetch callee-side call analysis: {exc}"
        failures = callee_check_failures(task.callee_checks, structured)
        if failures:
            return False, "callee-side checks failed: " + "; ".join(failures)
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


# ============================================================
# API helpers
# ============================================================

_cached_headers: Optional[dict] = None
_cached_headers_user_id: Optional[str] = None
_auth_mode: Optional[str] = None  # "jwt" or "api_key"


def _current_benchmark_user_id() -> str:
    return os.environ.get("BENCHMARK_RUN_USER_ID", "").strip() or USER_ID


def _free_credit_subscription_gate_user_id() -> str:
    return (
        os.environ.get("BENCHMARK_FREE_CREDIT_SUBSCRIPTION_GATE_USER_ID", "").strip()
        or FREE_CREDIT_SUBSCRIPTION_GATE_USER_ID
    )


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
    if not _is_local_base_url(base_url):
        return None
    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace:
        return None
    return f"navi-agent-tasks-{workspace}"


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
    goal = os.environ.get("BENCHMARK_GOAL_OVERRIDE") or _prod_user_data_prompt_override(task) or task.prompt
    goal = goal.replace("{frontend_url}", _frontend_url_for_benchmark(base_url))
    goal = resolve_callee_prompt(goal, getattr(task, "_callee_phone_number", ""), task.name)
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

    write_lock_enabled = _benchmark_env_bool("BENCHMARK_WRITE_LOCK_ENABLED")
    if write_lock_enabled is not None:
        body["write_lock_enabled"] = write_lock_enabled

    # A task-level declaration wins because live side-effect benchmarks must not
    # replay cached decisions. Tasks without a declaration retain the env A/B toggle.
    fast_mode_cache = _resolved_fast_mode_cache(task)
    if fast_mode_cache is not None:
        body["fast_mode_cache_enabled"] = fast_mode_cache

    if task.start_phase:
        body["start_phase"] = task.start_phase
    if task.response_schema:
        body["response_schema"] = task.response_schema

    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(f"{base_url}/api/agents", headers=headers, json=body)
        if resp.status_code not in (200, 201):
            raise Exception(f"Failed to create agent: {resp.status_code} - {resp.text}")
        data = resp.json()
        agent_id = data["agent_id"]
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
    benchmark_passed: Optional[bool] = None,
    benchmark_status: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> tuple[Optional[str], dict]:
    """Finalize durable trace storage and score WMH prediction fidelity for the run."""

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
        await client.delete(f"{base_url}/api/agents/{agent_id}", headers=headers)


async def get_tool_usage(base_url: str, agent_id: str) -> dict:
    """GET /api/tool-usage/tree/:id — aggregated cache metrics for entire agent tree."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/tool-usage/tree/{agent_id}", headers=headers)
        if resp.status_code == 200:
            return resp.json()
        return {}


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
    """Aggregate provider attribution and repeatable cache usage for an agent tree."""
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
    return aggregate_usage_items(items), aggregate_repeatable_cache_usage(items)


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
    max_attempts: int = 3,
    retry_delay_seconds: float = 2,
    fetch_lifecycle: Callable[[str, str], Awaitable[dict]] = get_test_payment_lifecycle,
) -> dict:
    """Bound transient provider failures while assembling the first lifecycle snapshot."""
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
) -> dict:
    """Observe durable recovery while AgentCard asynchronously releases a closed-card hold."""
    lifecycle = initial_lifecycle
    deadline = time.monotonic() + timeout_seconds
    retryable_statuses = {"FUNDING_RECLAIM_FAILED", "REFUND_FAILED"}
    consecutive_fetch_errors = 0
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
        if (status not in retryable_statuses and not compensation_pending) or time.monotonic() >= deadline:
            return lifecycle
        await asyncio.sleep(poll_interval_seconds)
        try:
            lifecycle = await (recover_lifecycle or fetch_lifecycle)(base_url, agent_id)
            consecutive_fetch_errors = 0
        except Exception as error:
            # Lifecycle reads join local DB state with several read-only provider
            # views. A single transient provider timeout must not turn a
            # successfully compensated purchase into a benchmark failure. Keep
            # the last durable snapshot and retry within the existing bounded
            # reconciliation window, but surface persistent outages promptly.
            consecutive_fetch_errors += 1
            if consecutive_fetch_errors >= 3 or time.monotonic() >= deadline:
                raise RuntimeError(
                    "Payment lifecycle remained unavailable after "
                    f"{consecutive_fetch_errors} consecutive reads: {error}"
                ) from error
            print(f"    ⚠ Transient payment lifecycle read failed ({consecutive_fetch_errors}/3); retrying: {error}")


async def abandon_test_payment(base_url: str, agent_id: str) -> dict:
    """Close/reclaim/refund a benchmark card after issuance but before merchant submission."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            f"{base_url}/api/test-payment/lifecycle/abandon",
            headers=headers,
            json={"agentId": agent_id},
        )
        if resp.status_code != 200:
            raise Exception(f"Failed to abandon test payment: {resp.status_code} {resp.text[:300]}")
        return resp.json()


async def configure_benchmark_agentcard_setup(base_url: str, action: str) -> dict:
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/test-payment/lifecycle/agentcard-setup",
            headers=headers,
            json={"userId": USER_ID, "action": action},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to {action} benchmark AgentCard setup: {resp.status_code} {resp.text[:300]}")
        return resp.json()


async def ensure_payment_lifecycle_cleanup(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
) -> Optional[dict]:
    """Idempotently compensate issued benchmark cards before agent deletion."""
    if not agent_id or task.payment_card_request_action != "abandon":
        return None
    try:
        lifecycle = await abandon_test_payment(base_url, agent_id)
        lifecycle = await _wait_for_expected_payment_lifecycle(
            base_url,
            agent_id,
            task,
            lifecycle,
            recover_lifecycle=abandon_test_payment,
        )
        print("    🧹 Confirmed payment-card transfer reclaim and Stripe refund")
        return lifecycle
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


async def respond_to_attention_request(base_url: str, request_id: str, response: str) -> None:
    """POST /api/attention-requests/:id/respond"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        await client.post(
            f"{base_url}/api/attention-requests/{request_id}/respond",
            headers=headers,
            json={"response": response},
        )


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
    """Require prod user-data benchmark grep calls to cover every provider explicitly."""
    seen_providers: set[str] = set()
    final_providers: set[str] = set()
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

        completion_summary = meta.get("completionSummary") or {}
        for output in completion_summary.get("outputs") or []:
            # Accept any provider checklist output. The agent's exact key name
            # varies run to run (provider_validation_checklist,
            # provider_verification_checklist, provider_checklist, ...), so match
            # on the "checklist" intent rather than an exact-name allowlist.
            output_key = str(output.get("key") or "").strip().lower()
            if output_key not in USER_DATA_PROD_CHECKLIST_KEYS and "checklist" not in output_key:
                continue
            for item in output.get("value") or []:
                if not isinstance(item, dict):
                    continue
                provider = str(item.get("provider") or "").strip().lower()
                if provider not in USER_DATA_PROD_DOCUMENT_SOURCES:
                    continue
                document_path = str(item.get("document_path") or "")
                appears_verified = bool(
                    item.get("appears_verified_from_prod_data", item.get("verified_from_prod_data"))
                )
                # Gate A already verified each provider was grepped from
                # source='documents', so we no longer parse the agent's free-form
                # `grep_filters_used` string (its wording/key names vary run to
                # run and produced false negatives). A checklist row counts as
                # covering its provider when it either cites a concrete
                # documents/<provider> evidence path OR honestly reports that the
                # provider had no synced prod data (verified flag False) — a
                # legitimately-empty provider is a correct outcome and must not
                # fail the checklist. Only a row that CLAIMS verification without
                # a documents/ path (fabricated evidence) is rejected.
                if appears_verified and not document_path.startswith("documents/"):
                    continue
                final_providers.add(provider)

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
    missing_final = USER_DATA_PROD_DOCUMENT_SOURCES - final_providers
    if missing_final:
        return (
            "User-data prod grep final provider_validation_checklist must cite every V1 provider "
            "with source='documents' grep filters and a prod evidence boolean. "
            f"Missing final providers: {sorted(missing_final)}. Seen: {sorted(final_providers)}"
        )
    return None


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
    return _validate_user_data_prod_grep_messages(messages)


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


async def upload_attachment(base_url: str, agent_id: str, filepath: str) -> Optional[dict]:
    """Upload a file attachment for an agent. Returns FilePointer or None."""
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
            return data.get("file_pointer") or data.get("filePointer")
        else:
            print(f"    ⚠ Attachment upload failed: {resp.status_code} - {resp.text[:200]}")
            return None


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
    from benchmarks.logs import _fly_collector

    if not _fly_collector:
        return []

    errors = []
    for aid in agent_ids:
        logs = _fly_collector.get_logs_for_agent(aid)
        for log_line in logs:
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


async def poll_agent(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
    realtime_monitor: Optional[SupabaseRealtimeSmokeMonitor] = None,
) -> Tuple[dict, int, int, Optional[str]]:
    """
    Poll agent until terminal state, timeout, or early-failure.
    Monitors the ENTIRE agent tree for stall detection, not just the root.

    Returns: (final_agent_data, approvals_triggered, approvals_resolved, early_fail_reason)
    early_fail_reason is non-None when a fail-fast condition tripped (per-agent
    stall, context validation error, dynamic timeout). The caller overrides
    pass→fail based on this.
    """
    start = time.time()
    last_activity_time = start  # tracks ANY activity across the entire tree
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
    seen_attention_ids: set[str] = set()
    seen_attention_kinds: List[str] = []
    agentcard_setup_attention_seen = False
    agentcard_setup_attention_id: Optional[str] = None
    attention_requests_seen: list[dict] = []
    chat_assistant_seen_at: Optional[float] = None
    payment_card_action_completed = False
    task._mid_run_feedback_posted = False
    task._mid_run_feedback_initial_schema = None

    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)

    while True:
        elapsed = time.time() - start
        if elapsed > resolved_timeout:
            reason = (
                f"Timeout after {elapsed:.0f}s (dynamic cap={resolved_timeout}s)"
                f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}"
                f" | Cache/cost: python agents/benchmarks/run_benchmark.py --compare <run.json>"
            )
            print(f"    ⏰ {reason}")
            data = await get_agent(base_url, agent_id)
            return data, approvals_triggered, approvals_resolved, reason

        # Hot-path HTTP — fetch root agent and (if the task handles approvals)
        # attention-requests in parallel. Saves ~150ms per poll.
        fetch_approvals_now = task.approval_handling in ("auto_approve", "ignore", "prompt_user", "count_only")
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
            lifecycle = await abandon_test_payment(base_url, agent_id)
            lifecycle = await _wait_for_expected_payment_lifecycle(
                base_url,
                agent_id,
                task,
                lifecycle,
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
        feedback_config = task.mid_run_feedback or {}
        if feedback_config and not task._mid_run_feedback_posted and status not in TERMINAL_STATUSES:
            after_message_count = int(feedback_config.get("after_root_message_count", 1))
            feedback_message = feedback_config.get("message")
            initial_schema = agent.get("response_schema")
            if (
                root_msg_count >= after_message_count
                and isinstance(feedback_message, str)
                and feedback_message.strip()
                and isinstance(initial_schema, dict)
                and initial_schema.get("fields")
            ):
                if await post_message(base_url, agent_id, feedback_message):
                    task._mid_run_feedback_initial_schema = json.loads(json.dumps(initial_schema))
                    task._mid_run_feedback_posted = True
                    print(
                        "    💬 Injected mid-run feedback after "
                        f"{root_msg_count} root messages; captured {len(initial_schema['fields'])} schema field(s)"
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
                    chat_assistant_seen_at = time.time()
                if time.time() - chat_assistant_seen_at >= 10:
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
        now = time.time()
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
            # silent for ≥ AGENT_STALL_SECONDS. If the most-recently-active
            # leaf still emitted within the threshold, the tree is making
            # progress somewhere — not stalled.
            if leaves:
                max_leaf_change = max(per_agent_state.get(aid, {}).get("last_change_time", 0.0) for aid in leaves)
                tree_idle = now - max_leaf_change
                if tree_idle > AGENT_STALL_SECONDS:
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
                        f"silent for {tree_idle:.0f}s (threshold={AGENT_STALL_SECONDS}s, "
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
                                    and task.approval_handling == "auto_approve"
                                    and observed_kind == "payment_approval"
                                ):
                                    await respond_to_attention_request(base_url, req_id, "approved")
                                    approvals_resolved += 1
                                    print(f"    ✅ Auto-approved payment-card prerequisite {req_id[:8]}")
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
                            receipt_error = _validate_payment_receipt(task, req)
                            if receipt_error:
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "payment_receipt_validation_error": receipt_error,
                                    "payment_receipt_request_id": req_id,
                                }
                                return data, approvals_triggered, approvals_resolved, receipt_error
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
                            if task.expected_gate:
                                data["_benchmark"] = {
                                    **data.get("_benchmark", {}),
                                    "expected_gate_seen": True,
                                    "expected_gate": (req.get("metadata") or {}).get("gate"),
                                    "expected_gate_request_id": req_id,
                                }
                            if task.expected_payment_receipt:
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
                            if task.approval_handling == "ignore":
                                kind_label = (
                                    f" ({observed_kind})"
                                    if task.expected_attention_kind or task.expected_attention_kinds
                                    else ""
                                )
                                print(f"    ✅ Approval request observed{kind_label} {req_id[:8]}")
                                return data, approvals_triggered, approvals_resolved, None
                            if (
                                task.agentcard_setup_action == "complete"
                                and observed_kind == "agentcard_user_cardholder_onboarding_required"
                            ):
                                await configure_benchmark_agentcard_setup(base_url, "complete")
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
    """Require non-goal mid-run feedback to leave the response schema untouched."""
    if not task.mid_run_feedback:
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
        if task.expected_attention_kind:
            benchmark_state = data.get("_benchmark", {})
            if benchmark_state.get("expected_attention_kind_seen") != task.expected_attention_kind:
                return False, f"Expected {task.expected_attention_kind} attention request but it was not observed"
        if task.expected_attention_kinds:
            benchmark_state = data.get("_benchmark", {})
            observed_kind = benchmark_state.get("attention_request_kind_seen")
            if observed_kind not in task.expected_attention_kinds:
                return (
                    False,
                    f"Expected one of {task.expected_attention_kinds} attention requests, observed {observed_kind}",
                )
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

    if task.success_on_payment_card_request:
        benchmark_state = data.get("_benchmark", {})
        if benchmark_state.get("expected_payment_receipt_seen"):
            lifecycle_error = _validate_payment_lifecycle(task, data)
            if lifecycle_error:
                return False, lifecycle_error
            return True, None
        return False, "Expected validated payment-card request but none was observed"

    # Agent mode: must complete
    if status != "COMPLETED":
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

    if task.name == AGENT_PAYMENT_TEST_SHOP_TASK_NAME:
        passed, reason = _evaluate_agent_payment_result(data)
        if not passed:
            return False, reason
    if task.expected_payment_lifecycle:
        lifecycle_error = _validate_payment_lifecycle(task, data)
        if lifecycle_error:
            return False, lifecycle_error
    if task.name == GREP_EXPLORE_STRESS_TASK_NAME:
        return True, None

    # Check approval expectations
    if task.approval_handling in ("auto_approve", "prompt_user") and approvals_triggered == 0:
        if task.name == f"{MINTED_AGENT_ACCOUNT_X_TASK_NAME}-post" and _x_signup_has_terminal_phone_blocker(
            _agent_data_search_text(data)
        ):
            return True, None
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
    if os.environ.get("BENCHMARK_KEEP_AGENTS") == "true":
        return False
    return passed or not keep_failed_agents


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


def _local_victoria_database_url() -> Optional[str]:
    candidates: list[str] = []
    services_path = _benchmark_context_path() / "services.json"
    if services_path.exists():
        try:
            services = json.loads(services_path.read_text())
            if _services_manifest_is_active(services):
                candidates.append(manifest_database_url(services))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Invalid benchmark services manifest at {services_path}: {exc}") from exc
    if not candidates:
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
        result = subprocess.run(
            ["psql", database_url, "-t", "-A", "-c", "SELECT 1;"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return database_url
    return None


def _shared_workspace_database_url() -> Optional[str]:
    """Return the healthy top-level workspace DB when a run uses an isolated DB."""
    shared_context = REPO_ROOT / ".context"
    try:
        if _benchmark_context_path().resolve() == shared_context.resolve():
            return None
    except OSError:
        return None

    services_path = shared_context / "services.json"
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

    try:
        result = subprocess.run(
            ["psql", database_url, "-t", "-A", "-c", "SELECT 1;"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    return database_url if result.returncode == 0 else None


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
    return configured_url


def _compute_token_source_database_url(target_database_url: str) -> tuple[Optional[str], Optional[str]]:
    """Choose a distinct, credential-bearing source for compute-token refresh."""
    target_identity = _database_endpoint_identity(target_database_url)
    if target_identity is None:
        return None, None

    shared_source = _shared_workspace_database_url()
    shared_identity = _database_endpoint_identity(shared_source or "")
    if shared_source and shared_identity and shared_identity != target_identity:
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


def _run_local_victoria_sql(sql: str) -> str:
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


def _plaid_transactions_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for Plaid transaction benchmark fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = USER_ID
    source_database_url = load_env_var("DATABASE_URL", _BACKEND_ENV)
    if source_database_url:
        source_database_url = _psql_compatible_database_url(source_database_url)
        if source_database_url != database_url:
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
    source_database_url = load_env_var("DATABASE_URL", _BACKEND_ENV)
    if source_database_url:
        source_database_url = _psql_compatible_database_url(source_database_url)
        if source_database_url != database_url:
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


def _free_credit_subscription_fixture_env() -> dict:
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for free-credit subscription fixture")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["BENCHMARK_USER_ID"] = _free_credit_subscription_gate_user_id()
    return env


def _run_free_credit_subscription_fixture(action: str) -> dict:
    result = subprocess.run(
        ["npx", "tsx", "scripts/free-credit-subscription-gate-fixture.ts", action],
        cwd=REPO_ROOT / "back-end",
        env=_free_credit_subscription_fixture_env(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"free-credit subscription benchmark fixture {action} failed: {(result.stderr or result.stdout).strip()}"
        )
    return _parse_last_json_line(result.stdout)


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


def _sync_compute_tokens(
    *,
    tolerate_gpt_code_unavailable: bool = False,
    tolerate_claude_code_unavailable: bool = False,
    required_token_types: tuple[str, ...] | None = None,
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
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
    env.pop("SEED_ALLOW_MISSING_GPT_CODE", None)
    compute_token_source, source_label = _compute_token_source_database_url(database_url)
    if not compute_token_source:
        print("    ⚠ Compute-token sync skipped: no distinct credential-bearing source database found")
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
    return True


def _sync_browser_credentials(cookie_domains: tuple[str, ...] = ()) -> bool:
    """Refresh the complete live browser auth graph (context/provider profiles,
    cookies/storage, CookieBundles, Steel sessions, passwords, and passkeys) from
    prod into the isolated benchmark DB. Same pattern as
    _sync_compute_tokens: a one-time setup-db sync goes stale as cookies expire,
    so the live fixture re-pulls them right before the agent starts.
    Best-effort but loud. Reads the prod source from back-end/.env.

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


def _sync_passkeys() -> None:
    """Refresh only passkeys from prod into the isolated benchmark DB.

    Unlike the broad base fixture, this deliberately excludes cookies, origin
    storage, browser profiles, and passwords. Failure is fatal because an old
    or missing passkey would invalidate the benchmark rather than merely make
    it less convenient.
    """
    database_url = _local_victoria_database_url()
    if not database_url:
        raise RuntimeError("Local Victoria DB connection not found for passkey-only sync")
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env["DIRECT_URL"] = database_url
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
    payment) run on claude_code, not Codex, so gating them on gpt_code is a FALSE
    infra failure — it dropped every live task while the pre-flight for the same
    run already tolerated the exact same absence. A genuinely Codex-dependent task
    still fails at runtime when its Codex call fails, not falsely here.
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
        synced_compute_tokens = _sync_compute_tokens(required_token_types=("gpt",))
    else:
        synced_compute_tokens = _sync_compute_tokens(
            tolerate_gpt_code_unavailable=True,
            tolerate_claude_code_unavailable=ctx.tolerate_claude_code_unavailable,
        )
    if not synced_compute_tokens:
        raise RuntimeError("Live fixture could not refresh compute tokens")
    if not _sync_browser_credentials(ctx.cookie_domains):
        raise RuntimeError("Live fixture could not refresh complete browser auth state")
    return {"fixture": "live", "browser_auth": True, "source": "prod_sync"}


async def _refresh_local_compute_tokens_for_run(base_url: str) -> None:
    """Refresh agent-infrastructure compute credentials once before local tasks.

    Real local tasks refresh from the verified shared workspace. Simulated cloud
    stacks already restore the current dated seed dump and deliberately have no
    second source DB endpoint, so they use that restored credential state.
    """
    if not _is_local_base_url(base_url):
        return
    if _is_simulate_mode():
        print("    🌍 simulate mode — using compute tokens from the restored seed DB")
        return
    if _anthropic_family_excluded():
        if not _sync_compute_tokens(required_token_types=("gpt",)):
            raise RuntimeError("Benchmark run could not refresh local compute tokens")
        return
    # Blanket pre-flight: the agent runtime uses claude_code, so a quota-blocked
    # Codex (gpt_code) must not fail the whole run when claude_code is healthy.
    # Codex-dependent tasks keep their own strict credential gates downstream.
    tolerate_missing_claude = await _has_usable_anthropic_api_key_fallback(base_url)
    if not _sync_compute_tokens(
        tolerate_gpt_code_unavailable=True,
        tolerate_claude_code_unavailable=tolerate_missing_claude,
    ):
        raise RuntimeError("Benchmark run could not refresh local compute tokens")


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


LIVE_FIXTURE_APPLIERS = {
    "live": _apply_live_fixture,
}
assert set(LIVE_FIXTURE_APPLIERS) == set(LIVE_FIXTURE_NAMES), (
    f"live-fixture appliers {sorted(LIVE_FIXTURE_APPLIERS)} must match registry {sorted(LIVE_FIXTURE_NAMES)}"
)


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
    tolerate_missing_claude = await _has_usable_anthropic_api_key_fallback(base_url)
    ctx = LiveFixtureContext(
        base_url=base_url,
        user_id=USER_ID,
        auth_realm=auth_realm,
        cookie_domains=cookie_domains,
        tolerate_claude_code_unavailable=tolerate_missing_claude,
    )
    manifests: list[dict] = []
    for name in fixtures:
        applier = LIVE_FIXTURE_APPLIERS.get(name)
        if applier is None:
            raise RuntimeError(f"{task.name}: unknown live_fixture '{name}'")
        manifests.append(applier(ctx))
    if task.name == AMAZON_PASSKEY_TASK_NAME and not _is_simulate_mode():
        manifests.append(_apply_amazon_passkey_scenario(ctx))
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
    return str(message.get("text") or message.get("message") or message.get("content") or "")


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


def _webdecoy_exact_score_from_recordings(data: dict) -> Optional[float]:
    scores: List[float] = []
    for index_path in _webdecoy_network_recording_paths(data):
        score = _webdecoy_exact_score_from_network_log(index_path)
        if score is not None:
            scores.append(score)
    if not scores:
        return None
    return scores[-1]


def _evaluate_webdecoy_biometrics_result(data: dict) -> Tuple[bool, Optional[str]]:
    text = _agent_data_search_text(data)
    if "webdecoy.com/product/fcaptcha-demo" not in text and "fcaptcha" not in text:
        return False, "No grounded evidence that the WebDecoy FCaptcha demo was visited"
    if not any(marker in text for marker in ("click", "clicked", "checkbox")):
        return False, "No grounded evidence of checkbox interaction"
    if not any(marker in text for marker in ("benchmark-human@example.com", "invisible mode", "submit")):
        return False, "No grounded evidence of invisible-mode form interaction"

    score_patterns = (
        r"risk\s*score[^0-9]{0,24}([0-9]+(?:\.[0-9]+)?)",
        r"([0-9]+(?:\.[0-9]+)?)\s*[^a-z0-9]{0,12}risk\s*score",
    )
    scores: list[float] = []
    for pattern in score_patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            try:
                scores.append(float(match.group(1)))
            except ValueError:
                continue

    exact_score = _webdecoy_exact_score_from_recordings(data)
    if exact_score is None and not scores:
        return False, "No FCaptcha risk score was reported"

    final_score = exact_score if exact_score is not None else scores[-1]
    score_source = "captured API" if exact_score is not None else "visible"
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
    if final_score > WEBDECOY_RISK_RATCHET:
        return False, (
            f"FCaptcha {score_source} risk score {final_score:.3f} exceeds ratchet {WEBDECOY_RISK_RATCHET:.3f} "
            f"(lower = more human; this gate only ratchets down, never up)"
        )
    return True, None


def _x_signup_has_terminal_phone_blocker(signup_text: str) -> bool:
    """Return true when X forced phone auth and rejected it before account creation."""
    normalized = signup_text.lower()
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
) -> TaskResult:
    """Run the most sensitive public biometrics score gate before auth-bundle probes."""
    gate_task = get_task_by_name(BIOMETRICS_WEBDECOY_TASK_NAME)
    print("    🧬 Auth bundle biometrics gate: WebDecoy FCaptcha score must be 0.00")
    return await run_single_task(base_url, gate_task, keep_failed_agents=keep_failed_agents)


async def run_minted_agent_account_task(
    base_url: str,
    task: BenchmarkTask,
    keep_failed_agents: bool = False,
) -> TaskResult:
    """Run the stateful minted-account benchmark: signup task, DB assertion, booking task."""
    if "localhost" not in base_url and "127.0.0.1" not in base_url:
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id="",
            status="SKIPPED",
            progress_score=0,
            duration_seconds=0,
            cost_cents=0,
            message_count=0,
            failure_reason="Minted account benchmark is local-only because it deletes local DB rows.",
        )

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
    clear_existing_auth = _benchmark_env_bool("BENCHMARK_MINTED_CLEAR_EXISTING_AUTH") is True
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
        )
        if not auth_bundle_biometrics_result.passed:
            return TaskResult(
                name=task.name,
                passed=False,
                agent_id=auth_bundle_biometrics_result.agent_id,
                status="FAILED",
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
            title="Minted Agent Account X Post",
            prompt=_x_post_prompt(),
            approval_handling="auto_approve",
            expected_attention_kind="write_lock",
            timeout_seconds=max(task.timeout_seconds, 900),
        )
        previous_write_lock = os.environ.get("BENCHMARK_WRITE_LOCK_ENABLED")
        os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = "true"
        try:
            post_result = await run_single_task(base_url, post_task, keep_failed_agents=keep_failed_agents)
        finally:
            if previous_write_lock is None:
                del os.environ["BENCHMARK_WRITE_LOCK_ENABLED"]
            else:
                os.environ["BENCHMARK_WRITE_LOCK_ENABLED"] = previous_write_lock

        minted = _get_local_minted_account(USER_ID, target_realm)
        if minted:
            print(f"    ✅ Minted account persisted for {target_realm}: {minted['account_label']}")
        else:
            print(f"    ❌ No minted account persisted for {target_realm}")
        post_text = _task_result_search_text(post_result)
        post_evidence = "hello world" in post_text and any(
            marker in post_text for marker in ("posted", "post submitted", "post was submitted", "successfully posted")
        )
        x_terminal_phone_blocker = _x_signup_has_terminal_phone_blocker(post_text)
        passed = post_result.passed and minted is not None and post_evidence and not x_terminal_phone_blocker
        failure_parts = []
        if minted is None:
            failure_parts.append(f"no MintedAccount row for {target_realm}")
        if x_terminal_phone_blocker:
            failure_parts.append("X forced phone auth and returned a terminal phone-auth blocker")
        if not post_result.passed:
            failure_parts.append(f"post failed: {post_result.failure_reason or post_result.status}")
        if post_result.passed and not post_evidence and not x_terminal_phone_blocker:
            failure_parts.append("no grounded evidence that the Hello World post was submitted")
        return TaskResult(
            name=task.name,
            passed=passed,
            agent_id=_with_gate_agent_ids(post_result.agent_id),
            status="COMPLETED" if passed else "FAILED",
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
            signup_result = await run_single_task(base_url, signup_task, keep_failed_agents=keep_failed_agents)
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
                return TaskResult(
                    name=task.name,
                    passed=False,
                    agent_id=_with_gate_agent_ids(signup_result.agent_id),
                    status="FAILED",
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
                post_result = await run_single_task(base_url, post_task, keep_failed_agents=keep_failed_agents)
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

            return TaskResult(
                name=task.name,
                passed=passed,
                agent_id=_with_gate_agent_ids(signup_result.agent_id, post_result.agent_id),
                status="COMPLETED" if passed else "FAILED",
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

            return TaskResult(
                name=task.name,
                passed=passed,
                agent_id=_with_gate_agent_ids(signup_result.agent_id),
                status="COMPLETED" if passed else "FAILED",
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
            booking_result = await run_single_task(base_url, booking_task, keep_failed_agents=keep_failed_agents)
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

        return TaskResult(
            name=task.name,
            passed=passed,
            agent_id=_with_gate_agent_ids(signup_result.agent_id, booking_result.agent_id),
            status="COMPLETED" if passed else "FAILED",
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


def _declared_evaluator_evidence(data: dict) -> list[dict]:
    """Build a bounded evidence-only context for a declared LLM judge."""
    evidence: list[dict] = []
    for message in (data.get("messages") or [])[-120:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").upper()
        if role in {"USER", "SYSTEM"}:
            continue
        text_value = message.get("text", message.get("content", ""))
        if not isinstance(text_value, str):
            text_value = json.dumps(text_value, default=str)
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        evidence.append(
            {
                "role": role or "UNKNOWN",
                "text": text_value[:12000],
                "metadata": {
                    key: metadata[key]
                    for key in (
                        "action_type",
                        "toolName",
                        "toolStatus",
                        "url",
                        "title",
                        "browser_session_metadata",
                    )
                    if key in metadata
                },
            }
        )
    evidence.append({"benchmark_state": data.get("_benchmark", {})})
    return evidence


async def _call_declared_llm_judge(
    task: BenchmarkTask,
    evaluator: dict,
    data: dict,
) -> dict:
    """Execute one catalog-declared single-turn judge against grounded run evidence."""
    from helpers.llm import check_progress

    criteria = "\n".join(f"- {criterion}" for criterion in evaluator.get("criteria", []))
    verifier_prompt = f"""You are a strict benchmark judge for a live ecommerce transaction.

The task prompt and criteria below describe requirements; they are not evidence. Score exactly 1.0 only
when every criterion is directly grounded in tool/browser output or typed benchmark state. Otherwise score
0.0 and explain the first missing or contradicted requirement. An attention request proves only its typed
terminal gate; it does not prove item, price, date, address, quantity, or selection constraints. Unsupported
assistant claims are not proof. Authentication assistance, login blockers, missing inventory, and unavailable
eligible orders fail unless a criterion explicitly defines that state as success.

Task requirement: {task.prompt}
Criteria:
{criteria}
Judge-specific instruction: {evaluator.get("judge_prompt", "")}
"""
    evidence = _declared_evaluator_evidence(data)
    return await check_progress(
        context=[
            {
                "role": "USER",
                "text": "Evaluate the supplied run evidence against the benchmark requirements.",
            },
            {
                "role": "TOOL",
                "text": json.dumps(evidence, default=str),
            },
        ],
        verifier_system_prompt=verifier_prompt,
        response_schema=None,
        call_site="benchmark_declared_evaluator",
        agent_id=(data.get("agent") or {}).get("agent_id") or (data.get("agent") or {}).get("id"),
    )


def _browser_agent_runtime_facts(data: dict) -> tuple[int, list[str]]:
    """Return distinct browser attempts and grounded failed lifecycle events."""
    failures: list[str] = []
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            tool_name = candidate.get("toolName") or candidate.get("tool_name")
            is_browser = tool_name == "spawn_browser_agent" or (
                tool_name == "spawn_agent" and candidate.get("agentType") == "browser"
            )
            if not is_browser:
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
    browser_instances = _agent_class_step_counts(data).get("browser", {})
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
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        for tool_call in metadata.get("tool_calls", []) or []:
            if not isinstance(tool_call, dict):
                continue
            tool_name = tool_call.get("tool")
            agent_class = tool_call.get("type") or _AGENT_CLASS_BY_RUNTIME_TOOL.get(tool_name)
            if tool_name == "spawn_agent" or tool_name in _AGENT_CLASS_BY_RUNTIME_TOOL:
                register(agent_class, tool_call.get("tool_call_id") or tool_call.get("toolCallId"))

    step_events: list[tuple[tuple[str, str], dict, bool]] = []
    for message in messages:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            tool_name = candidate.get("toolName") or candidate.get("tool_name")
            agent_class = (
                candidate.get("agentType") or candidate.get("agent_type") or _AGENT_CLASS_BY_RUNTIME_TOOL.get(tool_name)
            )
            if not agent_class:
                continue
            direct_ids = [
                candidate.get("subAgentId"),
                candidate.get("sub_agent_id"),
                candidate.get("task_id"),
                candidate.get("taskId"),
            ]
            nodes = [node for value in direct_ids if (node := register(agent_class, value))]
            tool_call_id = candidate.get("toolCallId") or candidate.get("tool_call_id")
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
    return counts


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


def _tool_runtime_failures(data: dict) -> list[str]:
    """Return grounded failed tool lifecycle events from the root trajectory."""
    failures: list[str] = []
    for message in data.get("messages", []) or []:
        metadata = message.get("metadata") if isinstance(message, dict) else None
        if not isinstance(metadata, dict):
            continue
        candidates = [metadata]
        if isinstance(metadata.get("auxiliary"), dict):
            candidates.append(metadata["auxiliary"])
        for candidate in candidates:
            tool_name = candidate.get("toolName") or candidate.get("tool_name")
            if not tool_name:
                continue
            status = str(candidate.get("toolStatus") or candidate.get("tool_status") or "").upper()
            event_data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
            if status in {"CANCELLED", "ERROR", "FAILED"} or event_data.get("success") is False:
                call_id = candidate.get("toolCallId") or candidate.get("tool_call_id") or "unknown"
                failures.append(f"{tool_name} {call_id} status={status or 'unsuccessful'}")
    return failures


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
_APPROVAL_SEAT_RE = re.compile(
    r"(?:\bseat(?:s)?(?:\s+(?:number|assignment))?\s*[:#-]?\s*[a-z]{1,2}\s*-?\s*\d{1,3}\b|"
    r"\brow\s+[a-z]{1,2}\s*,?\s+seat\s+\d{1,3}\b|"
    r"[\"\']seat[\"\']\s*:\s*[\"\']?[a-z]{1,2}\s*-?\s*\d{1,3}\b)",
    re.IGNORECASE,
)


def _run_declared_static_check(evaluator: dict, data: dict) -> tuple[bool, str]:
    """Execute the small fail-closed static-check surface used by enforced tasks."""
    benchmark_state = data.get("_benchmark", {})
    for check in evaluator.get("checks", []):
        check_type = check.get("type")
        if check_type == "expected_payment_receipt":
            if benchmark_state.get("expected_payment_receipt_seen") is not True:
                return False, "Expected validated payment receipt was not observed"
            continue
        if check_type == "expected_gate":
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
            expected_status = str(check.get("value") or "COMPLETED").upper()
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
            required_strings = check.get("required_strings") or []
            require_date = check.get("require_date") is True
            minimum_date_count = int(check.get("minimum_date_count", 1 if require_date else 0))
            require_time = check.get("require_time") is True
            require_amount = check.get("require_amount") is True
            require_seat = check.get("require_seat") is True
            for request in requests:
                evidence = json.dumps(request, default=str).lower()
                if not all(str(value).lower() in evidence for value in required_strings):
                    continue
                if len(_APPROVAL_DATE_RE.findall(evidence)) < minimum_date_count:
                    continue
                if require_time and not _APPROVAL_CLOCK_RE.search(evidence):
                    continue
                if require_amount and not _APPROVAL_AMOUNT_RE.search(evidence):
                    continue
                if require_seat and not _APPROVAL_SEAT_RE.search(evidence):
                    continue
                break
            else:
                missing = ", ".join(str(value) for value in required_strings) or "required details"
                if minimum_date_count == 1:
                    date_suffix = " and a calendar date"
                elif minimum_date_count > 1:
                    date_suffix = f" and {minimum_date_count} calendar dates"
                else:
                    date_suffix = ""
                time_suffix = " and a reservation time" if require_time else ""
                amount_suffix = " and a monetary amount" if require_amount else ""
                seat_suffix = " and a seat assignment" if require_seat else ""
                return False, (
                    f"Approval request did not include {missing}{date_suffix}{time_suffix}{amount_suffix}{seat_suffix}"
                )
            continue
        return False, f"Unsupported enforced static check: {check_type}"
    return True, "All declared static checks passed"


async def _run_declared_evaluators(
    task: BenchmarkTask,
    data: dict,
) -> tuple[bool, Optional[str], list[dict]]:
    """Run required catalog evaluators; unsupported/erroring evaluators fail closed."""
    if not task.enforce_declared_evaluators:
        return True, None, []

    results: list[dict] = []
    for evaluator in task.evaluators:
        evaluator_id = evaluator.get("id", "unnamed")
        method = evaluator.get("method")
        usage = None
        try:
            if method == "static_check":
                passed, reasoning = _run_declared_static_check(evaluator, data)
                score = 1.0 if passed else 0.0
            elif method == "single_turn_llm_judge":
                judged = await _call_declared_llm_judge(task, evaluator, data)
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "Judge returned no reasoning")
                usage = judged.get("usage")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            else:
                passed = False
                score = 0.0
                reasoning = f"Unsupported enforced evaluator method: {method}"
        except Exception as exc:
            passed = False
            score = 0.0
            reasoning = f"Declared evaluator execution failed: {exc}"
        result = {
            "id": evaluator_id,
            "method": method,
            "score": score,
            "passed": passed,
            "reasoning": reasoning,
        }
        if usage is not None:
            result["usage"] = usage
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
) -> TaskResult:
    """Run a single benchmark task. Returns TaskResult."""
    _validate_task_target(task, base_url)
    previous_benchmark_user_id = os.environ.get("BENCHMARK_RUN_USER_ID")
    if task.name == FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME:
        os.environ["BENCHMARK_RUN_USER_ID"] = _free_credit_subscription_gate_user_id()
    elif task.name in GATE_FIXTURE_TASK_USER_IDS:
        os.environ["BENCHMARK_RUN_USER_ID"] = GATE_FIXTURE_TASK_USER_IDS[task.name]

    if task.name in MINTED_AGENT_ACCOUNT_TASK_NAMES:
        return await run_minted_agent_account_task(base_url, task, keep_failed_agents)

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
    if task.name == FREE_CREDIT_SUBSCRIPTION_GATE_TASK_NAME:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        free_credit_subscription_manifest = _run_free_credit_subscription_fixture("apply")
        print(
            "    💳 Prepared free-credit subscription gate fixture: "
            f"user={free_credit_subscription_manifest.get('user_id')} "
            f"credit={free_credit_subscription_manifest.get('credit_cents')}c "
            f"used={free_credit_subscription_manifest.get('used_cents')}c"
        )
    if task.name in GATE_FIXTURE_TASK_MODES:
        if not _is_local_base_url(base_url):
            raise RuntimeError(f"{task.name} must run against the local benchmark stack")
        gate_fixture_manifest = _run_gate_fixture(task.name, "apply")
        print(
            "    🚧 Prepared gate fixture: "
            f"mode={gate_fixture_manifest.get('fixture_mode')} "
            f"user={gate_fixture_manifest.get('user_id')}"
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

    phone_callee: Optional[PhoneCalleeSession] = None
    if task.phone_persona:
        phone_callee = PhoneCalleeSession(task.name, task.phone_persona)
        await phone_callee.setup()
        task._callee_phone_number = phone_callee.phone_number
        print(
            f"    📞 Benchmark callee ready: {phone_callee.phone_number} "
            f"(persona assistant {phone_callee.assistant_id[:8]})"
        )

    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)
    print(f"\n  {'=' * 50}")
    print(f"  📋 {task.name}: {task.title}")
    print(f"     timeout={resolved_timeout}s, price_limit={task.effective_price_limit_cents()}c")
    all_attachments = task.attachments or ([task.attachment] if task.attachment else [])
    if all_attachments:
        print(f"     attachments={all_attachments}")
    if task.approval_handling:
        print(f"     approval={task.approval_handling}")
    print(f"  {'=' * 50}")

    start = time.time()
    start_time = datetime.now(timezone.utc)
    agent_id = ""
    archive_manifest_ref: Optional[str] = None
    world_model_fidelity: Optional[dict] = None
    realtime_monitor: Optional[SupabaseRealtimeSmokeMonitor] = None
    realtime_tree_task: Optional[asyncio.Task] = None
    live_fixture_manifests: list[dict] = []

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
            while True:
                try:
                    for agent_info in await get_agent_tree(base_url, agent_id):
                        aid = agent_info.get("agent_id")
                        if aid and aid not in seen:
                            seen.add(aid)
                            await subscribe_supabase_realtime_agent(aid)
                except Exception:
                    pass
                await asyncio.sleep(2)

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

        # Handle attachments: create agent first, upload files, then post file messages
        if all_attachments:
            agent_id = await create_agent(base_url, task)
            if on_agent_created:
                on_agent_created(task.name, agent_id)
            print(f"    Agent created: {agent_id[:12]}...")
            await start_realtime_capture()
            await start_realtime_monitor()

            file_pointers = []
            for attach_filename in all_attachments:
                filepath = os.path.join(TEST_ASSETS_DIR, attach_filename)
                if not os.path.exists(filepath):
                    raise FileNotFoundError(f"Test asset not found: {filepath}")

                # Slice CSV if row_start/row_end are set
                if filepath.endswith(".csv") and task.row_start is not None and task.row_end is not None:
                    filepath = slice_csv(filepath, task.row_start, task.row_end)
                    temp_csv_paths.append(filepath)

                print(f"    Uploading {attach_filename}...")
                fp = await upload_attachment(base_url, agent_id, filepath)
                if fp:
                    file_pointers.append(fp)
                    print("    ✅ Uploaded, FilePointer received")
                else:
                    print("    ⚠ Upload returned no FilePointer, continuing anyway")

            # Post a message with all file pointers so the agent can see them
            if file_pointers:
                await post_attachment_message(base_url, agent_id, file_pointers)
                print(f"    📎 Posted {len(file_pointers)} file(s) as agent message")
            await post_world_model_update_events(base_url, agent_id)
            start_fixture_ref = await archive_agent_start(base_url, agent_id)
            if start_fixture_ref:
                print(f"    🧊 Trace archive start fixture: {start_fixture_ref}")
        else:
            agent_id = await create_agent(base_url, task)
            if on_agent_created:
                on_agent_created(task.name, agent_id)
            print(f"    Agent created: {agent_id[:12]}...")
            if task.name == GREP_EXPLORE_STRESS_TASK_NAME:
                grep_fixture_manifest = _run_grep_fixture("apply-agent-network", agent_id)
                print("    🔎 Attached seeded agent_network branch")
            await start_realtime_capture()
            await start_realtime_monitor()
            await post_world_model_update_events(base_url, agent_id)
            start_fixture_ref = await archive_agent_start(base_url, agent_id)
            if start_fixture_ref:
                print(f"    🧊 Trace archive start fixture: {start_fixture_ref}")

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
                progress_score=(data.get("agent") or {}).get("progress", 0),
                duration_seconds=round(duration, 1),
                cost_cents=0,
                message_count=len(messages),
                failure_reason=None,
            )

        # Poll until done (or early-fail)
        data, approvals_triggered, approvals_resolved, early_fail_reason = await poll_agent(
            base_url, agent_id, task, realtime_monitor
        )
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None

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
            usage = await get_tool_usage(base_url, agent_id)
            cost_cents = usage.get("total_cost_cents", 0)
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
            cost_cents = agent.get("tree_cost_cents", 0) or agent.get("tool_cost_cents", 0)

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
        llm_usage_by_provider, repeatable_cache_usage = await get_llm_usage_details(
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
            phone_passed, phone_reason = await _evaluate_phone_call_task(task, data, phone_callee)
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
        }
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
            except Exception as e:
                passed = False
                failure_reason = f"User-data prod grep contract check failed: {e}"

        cleanup_lifecycle = await ensure_payment_lifecycle_cleanup(base_url, agent_id, task)
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
        if task.enforce_declared_evaluators and passed:
            evaluator_passed, evaluator_reason, declared_evaluator_results = await _run_declared_evaluators(
                task,
                data,
            )
            data["_benchmark"] = {
                **data.get("_benchmark", {}),
                "declared_evaluator_results": declared_evaluator_results,
            }
            if not evaluator_passed:
                passed = False
                failure_reason = evaluator_reason

        # Collect prod logs for diagnostics
        print("    Collecting prod logs...")
        logs = await collect_logs(agent_id, data, start_time)
        if declared_evaluator_results:
            logs["declared_evaluators"] = declared_evaluator_results
        # Capture the FULL agent tree's messages (root + every spawned sub-agent) so
        # the archive can render the fan-out, not just the root. Without this a
        # for_each/spawn benchmark opens to a lone root with no visible tree. Only
        # when the run actually fanned out (>1 agent); best-effort — a capture
        # failure must never fail the benchmark itself.
        if tree_agent_count and tree_agent_count > 1:
            try:
                tree_agents = await get_agent_tree(base_url, agent_id)
                logs["tree"] = await collect_tree_messages(agent_id, tree_agents, lambda a: get_agent(base_url, a))
                print(f"    Tree messages captured for {len(logs['tree'])} agent(s)")
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
            progress_score=agent.get("progress", 0),
            duration_seconds=round(duration, 1),
            cost_cents=round(cost_cents, 2),
            message_count=len(messages),
            failure_reason=failure_reason,
            approvals_triggered=approvals_triggered,
            approvals_resolved=approvals_resolved,
            cache_read_input_tokens=cache_read_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_hit_pct=cache_hit_pct,
            repeatable_cache_read_input_tokens=int(repeatable_cache_usage["cache_read_input_tokens"]),
            repeatable_cache_creation_input_tokens=int(repeatable_cache_usage["cache_creation_input_tokens"]),
            repeatable_cache_hit_pct=float(repeatable_cache_usage["cache_hit_pct"]),
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
            fast_mode_cache_enabled=agent.get("fast_mode_cache_enabled") is True,
            context_violations=context_violation_dicts,
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            payment_lifecycle=(data.get("_benchmark") or {}).get("payment_lifecycle"),
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
        )

        icon = "✅" if passed else "❌"
        print(f"\n    {icon} {task.name}: {'PASS' if passed else 'FAIL'}")
        if failure_reason:
            print(f"       Reason: {failure_reason}")
        print(f"       Duration: {duration:.1f}s | Cost: {cost_cents:.1f}c | Messages: {len(messages)}")
        if total_input > 0:
            print(
                f"       Cache: read={cache_read_input_tokens} write={cache_creation_input_tokens} hit={cache_hit_pct}%"
            )
        repeatable_total = result.repeatable_cache_read_input_tokens + result.repeatable_cache_creation_input_tokens
        if repeatable_total > 0:
            print(
                "       Repeatable cache: "
                f"read={result.repeatable_cache_read_input_tokens} "
                f"write={result.repeatable_cache_creation_input_tokens} "
                f"hit={result.repeatable_cache_hit_pct}%"
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

    except asyncio.CancelledError:
        duration = time.time() - start
        print(f"\n    ⚠ {task.name}: CANCELLED — collecting logs before shutdown")
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None
        logs = None
        messages = []
        status = "CANCELLED"
        progress_score = 0
        if agent_id:
            try:
                data = await get_agent(base_url, agent_id)
                agent = data.get("agent", {})
                messages = data.get("messages", [])
                status = agent.get("status", "CANCELLED")
                progress_score = agent.get("progress", 0)
            except Exception:
                data = {}
            try:
                print("    Collecting prod logs...")
                logs = await collect_logs(agent_id, data, start_time)
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
            except Exception as log_exc:
                print(f"    ⚠ Failed to collect cancellation logs: {log_exc}")
            archive_manifest_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
                base_url,
                agent_id,
                task.name,
                force=True,
                benchmark_passed=False,
                benchmark_status="CANCELLED",
                failure_reason="Benchmark interrupted; prod logs were collected before shutdown",
            )
            await ensure_payment_lifecycle_cleanup(base_url, agent_id, task)
            try:
                if not keep_failed_agents:
                    await delete_agent(base_url, agent_id)
                    print(f"    🗑  Deleted cancelled agent {agent_id[:12]}")
                else:
                    print(f"    🧪 Keeping cancelled agent {agent_id[:12]} for diagnostics")
            except Exception:
                print(f"    ⚠ Failed to delete cancelled agent {agent_id[:12]}")
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id=agent_id,
            status=status,
            progress_score=progress_score,
            duration_seconds=round(duration, 1),
            cost_cents=0,
            message_count=len(messages),
            failure_reason=(
                "Benchmark interrupted; prod logs were collected before shutdown"
                + (f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}" if agent_id else "")
            ),
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
        )

    except Exception as e:
        duration = time.time() - start
        print(f"\n    ❌ {task.name}: ERROR - {type(e).__name__}: {e}")
        if realtime_monitor:
            await realtime_monitor.stop()
            realtime_monitor = None
        # Best-effort log collection — errors are when logs matter most
        logs = None
        if agent_id:
            try:
                logs = await collect_logs(agent_id, {}, start_time)
            except Exception:
                pass
            archive_manifest_ref, world_model_fidelity = await finalize_archive_and_score_world_model(
                base_url,
                agent_id,
                task.name,
                force=True,
                benchmark_passed=False,
                benchmark_status="ERROR",
                failure_reason=str(e),
            )
            await ensure_payment_lifecycle_cleanup(base_url, agent_id, task)
            try:
                if not keep_failed_agents:
                    await delete_agent(base_url, agent_id)
                    print(f"    🗑  Deleted orphaned agent {agent_id[:12]}")
                else:
                    print(f"    🧪 Keeping failed agent {agent_id[:12]} for diagnostics")
            except Exception:
                print(f"    ⚠ Failed to delete orphaned agent {agent_id[:12]}")
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id=agent_id,
            status="ERROR",
            progress_score=0,
            duration_seconds=round(duration, 1),
            cost_cents=0,
            message_count=0,
            failure_reason=(
                f"{e}"
                + (f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}" if agent_id else "")
                + " | Cache/cost: python agents/benchmarks/run_benchmark.py --compare <run.json>"
            ),
            logs=logs,
            archive_manifest_ref=archive_manifest_ref,
            world_model_fidelity=world_model_fidelity,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
        )
    finally:
        if realtime_tree_task:
            realtime_tree_task.cancel()
            await asyncio.gather(realtime_tree_task, return_exceptions=True)
        if realtime_monitor:
            await realtime_monitor.stop()
        if phone_callee is not None:
            await phone_callee.cleanup()
        for tmp in temp_csv_paths:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if plaid_transactions_fixture_action == "apply" and os.environ.get("BENCHMARK_CLEANUP_PLAID_FIXTURE") == "1":
            try:
                _run_plaid_transactions_fixture("cleanup")
            except Exception as exc:
                print(f"    ⚠ Failed to clean up synthetic Plaid transaction fixture: {exc}")
        _restore_live_fixture_scenarios(live_fixture_manifests)
        if previous_benchmark_user_id is None:
            os.environ.pop("BENCHMARK_RUN_USER_ID", None)
        else:
            os.environ["BENCHMARK_RUN_USER_ID"] = previous_benchmark_user_id


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
        non_agent_tasks = [task for task in tasks if task.runner != "agent"]
        if non_agent_tasks:
            names = ", ".join(f"{task.name} ({task.runner})" for task in non_agent_tasks)
            raise ValueError(
                f"Task(s) {names} are not agent evals — run them via "
                f"benchmarks/run_eval_suite.py or their own test runner, not run_benchmark.py."
            )
    elif args.suite:
        if args.suite == "all":
            tasks = all_tasks()
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
            tasks = [t for t in all_tasks() if t.bench == args.suite]
        else:
            tasks = get_tasks_by_tag(args.suite)
    else:
        tasks = all_tasks()

    if not explicit_task_names:
        # Suite selection only runs complete benchmark evals. `status == "incomplete"`
        # entries (missing fixtures/judges) are skipped; explicit --task still targets
        # incomplete agent evals for dev iteration.
        tasks = [t for t in tasks if t.runner == "agent" and t.status == "ready"]
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
        "model": "rose-labs/rose-1-lite",
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


async def _terminate_stale_workflows():
    """Terminate all running Temporal workflows on the local task queue.

    Stale workflows from previous benchmark runs continue dispatching activities
    to the new worker, flooding the backend with 404s for deleted agents and
    consuming DB connections + LLM quota. Clearing them before a new run
    prevents cascading resource exhaustion.
    """
    try:
        from temporalio.client import Client, TLSConfig

        from config import load_config

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
            namespace=config.temporal.namespace,
            tls=TLSConfig(client_cert=None, client_private_key=None),
            rpc_metadata={
                "temporal-namespace": config.temporal.namespace,
                "Authorization": f"Bearer {config.temporal.api_key}",
            },
        )

        query = f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"'
        count = (await client.count_workflows(query)).count
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
    owns runtime selection: the key must be configured and the backend's shared
    out-of-credits circuit breaker must be clear. Any unavailable check fails
    closed and leaves Claude OAuth mandatory.
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
        return (
            isinstance(availability, dict)
            and availability.get("configured") is True
            and availability.get("onCooldown") is False
        )
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


async def _check_claude_code_credentials(base_url: str) -> bool:
    """Check whether Claude Code can actually create a code session.

    A GPT/Codex compute token is not sufficient for a task that explicitly calls
    ``spawn_claude_code_agent``. The runtime may have valid GPT credentials for
    ordinary agent turns while Claude Code still has no user token or pool token.
    Do not treat the shared Anthropic API-key fallback as sufficient here:
    credential-health is the live funded-key probe, and Anthropic failures are
    intentionally warn-only. This smoke gate is skippable when there is no real
    Claude Code credential, so it should not launch a task that may discover an
    unfunded or cooled-down fallback only after the benchmark starts.
    """
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{base_url}/api/integrations/compute-code/credentials/token",
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("type") == "claude" and bool(data.get("accessToken")):
                    return True
        return False
    except Exception:
        return False


def cache_ratchet_failures(
    task_results: list[TaskResult],
    floors: dict[str, float] = PER_TASK_CACHE_HIT_RATCHET,
) -> list[tuple[str, str, float, float]]:
    """Return repeatable-cache floor violations, including missing telemetry."""
    failures: list[tuple[str, str, float, float]] = []
    for result in task_results:
        if result.status == "SKIPPED":
            continue
        floor = floors.get(result.name)
        if floor is None:
            continue
        total = result.repeatable_cache_read_input_tokens + result.repeatable_cache_creation_input_tokens
        if total <= 0:
            if floor > 0:
                failures.append((result.name, result.agent_id, 0.0, floor))
            continue
        hit_pct = round(result.repeatable_cache_read_input_tokens / total * 100, 1)
        if hit_pct < floor:
            failures.append((result.name, result.agent_id, hit_pct, floor))
    return failures


def enforce_cache_ratchets(task_results: list[TaskResult]) -> None:
    """Fail the benchmark when repeatable cache reuse regresses or is absent."""
    failures = cache_ratchet_failures(task_results)
    if not failures:
        return
    print("\n  ❌ CACHE RATCHET FAILED (per-task repeatable prompt-cache hit floor):")
    for name, _agent_id, hit_pct, floor in failures:
        print(f"    - {name}: {hit_pct}% < {floor}% ratchet")
    print(
        "\n  Diagnose each failure with agent_cache.py to see per-LLM-call"
        "\n  read/write/hit% and find where the prefix fingerprint is drifting:"
    )
    for name, agent_id, _hit_pct, _floor in failures:
        print(f"    cd agents && source venv/bin/activate && python benchmarks/agent_cache.py {agent_id}  # {name}")
    print(
        "\n  Fix the cache miss (e.g. unstable prefix hash, model mix,"
        "\n  claudeAuth fall-through) and re-run until hit% ≥ ratchet."
    )
    raise SystemExit(1)


def _parallel_task_runners(
    tasks: list[BenchmarkTask],
    max_concurrency: int | None,
    runner: Callable[[BenchmarkTask], Awaitable[TaskResult]],
) -> list[Awaitable[TaskResult]]:
    """Build task runners with batch and shared browser-profile limits.

    Browser sessions persist changes into the benchmark user's provider profile.
    Two browser-backed tasks therefore cannot safely overlap: whichever session
    closes last can overwrite cookies, storage, and tabs written by its sibling.
    Keep that resource exclusive while allowing non-browser work to use the rest
    of the configured batch concurrency.
    """
    semaphore = (
        asyncio.Semaphore(max_concurrency) if max_concurrency is not None and max_concurrency < len(tasks) else None
    )
    browser_profile_writer = asyncio.Semaphore(1)

    async def run_with_batch_limit(task: BenchmarkTask) -> TaskResult:
        if semaphore is None:
            return await runner(task)
        async with semaphore:
            return await runner(task)

    async def run_limited(task: BenchmarkTask) -> TaskResult:
        if task.requires_browser_agent:
            # Acquire the resource-specific lock first so a queued browser task
            # does not consume a general slot that non-browser work can use.
            async with browser_profile_writer:
                return await run_with_batch_limit(task)
        return await run_with_batch_limit(task)

    return [run_limited(task) for task in tasks]


def _parallel_task_phases(
    tasks: list[BenchmarkTask],
) -> list[tuple[str, list[BenchmarkTask]]]:
    """Order destructive fixture tasks ahead of agent trees that may outlive a root.

    A timed-out task can be intentionally retained for diagnostics while one of
    its descendants continues working. Running a destructive fixture after the
    root future settles therefore is not isolated: the descendant can recreate
    shared rows during the fixture. Starting the exclusive phase first makes the
    clean-stack boundary real without sacrificing failed-tree diagnostics.
    """
    exclusive = [task for task in tasks if task.name in EXCLUSIVE_SHARED_DB_TASK_NAMES]
    parallel = [task for task in tasks if task.name not in EXCLUSIVE_SHARED_DB_TASK_NAMES]
    return [("exclusive", exclusive), ("parallel", parallel)]


async def main_async(args):
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

    tasks = resolve_tasks(args)
    if not tasks:
        print("No tasks matched. Use --list to see available tasks.")
        sys.exit(1)
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
        await _refresh_local_compute_tokens_for_run(base_url)

    # Pre-flight: check provider-typed compute credentials for code-agent tests.
    skipped_claude_tasks: List[BenchmarkTask] = []
    claude_code_tasks = [t for t in tasks if t.requires_claude_code]
    if claude_code_tasks:
        has_claude_creds = await _check_claude_code_credentials(base_url)
        if not has_claude_creds:
            skipped_names = [t.name for t in claude_code_tasks]
            print(f"  ⚠ Claude Code credentials unavailable — skipping: {', '.join(skipped_names)}")
            skipped_claude_tasks = claude_code_tasks
            tasks = [t for t in tasks if not t.requires_claude_code]

    await _update_world_model_before_simulation(args)

    # Pre-flight: resolve per-task timeout from history corpus.
    # In bootstrap mode, always use tasks.json timeout_seconds as the ceiling — passes
    # recorded this run seed/extend the corpus for future dynamic caps. This lets
    # bootstrap widen the cap when infra slowdown has pushed real durations past the
    # existing p95 (otherwise the tight dynamic cap kills every run before it can pass).
    # In non-bootstrap mode, incomplete history falls back to the configured task
    # timeout so new or low-sample tasks can still run and accumulate pass data.
    for t in tasks:
        if args.bootstrap:
            t._resolved_timeout_seconds = t.timeout_seconds
            s = _history_summary(t.name, max_seconds=get_smoke_cap(t.name))
            print(
                f"  🔧 bootstrap: {t.name} → {t.timeout_seconds}s "
                f"(history n={s['count']}, recent_max={s['recent_max']}s)"
            )
            continue
        cap = get_smoke_cap(t.name)
        try:
            history_timeout = _history_get_timeout(t.name, max_seconds=cap)
        except InsufficientHistoryError as e:
            t._resolved_timeout_seconds = _default_timeout_for_task(t, cap)
            print(f"  ⏱  {t.name} → {t._resolved_timeout_seconds}s (default; history n={e.have}/{e.need})")
        else:
            floor = get_timeout_floor(t.name)
            t._resolved_timeout_seconds = max(history_timeout, floor) if floor else history_timeout
            s = _history_summary(t.name, max_seconds=cap)
            cap_note = f", cap={cap}s" if cap else ""
            floor_note = f", floor={floor}s" if floor else ""
            print(
                f"  ⏱  {t.name} → {t._resolved_timeout_seconds}s "
                f"(recent_p95={s['recent_p95']}s, n={s['count']}{cap_note}{floor_note})"
            )

    # Start Fly.io log streaming
    fly_status = await start_fly_log_collector()
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
        # created unless the Mac app's persisted Hub can already resolve this
        # run. Final save uses the same required contract below via results.py.
        from benchmarks.hub_upload import DEFAULT_HUB_URL, require_run_visible

        os.environ.setdefault("BENCHMARK_HUB_UPLOAD_URL", DEFAULT_HUB_URL)
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
    for t in skipped_claude_tasks:
        run.task_results.append(
            TaskResult(
                name=t.name,
                passed=False,
                agent_id="",
                status="SKIPPED",
                progress_score=0,
                duration_seconds=0,
                cost_cents=0,
                message_count=0,
                failure_reason=CLAUDE_CODE_CREDENTIAL_SKIP_REASON,
            )
        )

    # Live report card: a standardized progress snapshot emitted to stdout + the run's
    # context dir once per second (and once, forced, at the end). Purely observational —
    # every emit is wrapped so it can never break a benchmark run.
    from benchmarks.report_card import Infra, ReportCardEmitter, RunState, TaskCard

    _report_emitter = ReportCardEmitter(os.environ.get("BENCHMARK_CONTEXT_DIR", ".context"))
    _report_start = time.monotonic()
    _live_task_agent_ids: dict[str, str] = {}

    def _remember_live_agent(task_name: str, agent_id: str) -> None:
        if task_name and agent_id:
            _live_task_agent_ids[task_name] = agent_id

    def _report_snapshot(running_names: set[str]) -> RunState:
        finished = {r.name for r in run.task_results}
        fe = _frontend_url_for_benchmark(base_url)
        try:
            peak_fly_raw = os.environ.get("BENCHMARK_PEAK_FLY_MACHINES")
            peak_fly_machines = int(peak_fly_raw) if peak_fly_raw else None
        except (TypeError, ValueError):
            peak_fly_machines = None
        task_world_model_modes = {t.name: t.world_model_mode for t in tasks if t.world_model_mode}
        per_task: list[TaskCard] = []
        for r in run.task_results:
            status = "skipped" if r.status == "SKIPPED" else ("passed" if r.passed else "failed")
            per_task.append(
                TaskCard(
                    name=r.name,
                    status=status,
                    duration_s=r.duration_seconds,
                    cost_usd=(r.cost_cents / 100.0) if r.cost_cents is not None else None,
                    agent_url=f"{fe}/?agent-id={r.agent_id}" if r.agent_id else None,
                    llm_call_count=r.llm_call_count,
                    tree_agent_count=r.tree_agent_count,
                    tokens_in=r.tokens_in,
                    tokens_out=r.tokens_out,
                    world_model_mode=task_world_model_modes.get(r.name),
                    fast_mode=bool(getattr(r, "fast_mode_cache_enabled", False)),
                    infra_usd=_infra_usd_for_elapsed(r.duration_seconds) if r.duration_seconds is not None else None,
                )
            )
        for name in running_names:
            if name not in finished:
                live_agent_id = _live_task_agent_ids.get(name)
                per_task.append(
                    TaskCard(
                        name=name,
                        status="running",
                        agent_url=f"{fe}/?agent-id={live_agent_id}" if live_agent_id else None,
                        world_model_mode=task_world_model_modes.get(name),
                    )
                )
        elapsed = time.monotonic() - _report_start
        wmh_usage = _fetch_wmh_usage()
        return RunState(
            run_id=run.run_id,
            elapsed_s=elapsed,
            world_model_mode=os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real"),
            total_tasks=len(tasks) + len(skipped_claude_tasks),
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

    def _emit_report(running_names: set[str], *, force: bool = False) -> None:
        try:
            _report_emitter.maybe_emit(_report_snapshot(running_names), force=force)
        except Exception as exc:  # observability must never fail the run
            print(f"  ⚠ report card emit failed: {exc}")

    # Live report card: a background ticker emits on a timer so the dashboard updates
    # DURING the run. The drain loop only emits on task-completion events, so a single
    # blocking task (or any long task) would otherwise leave the report screen blank
    # until the very end. `_report_running` is kept in sync by the branches below.
    _report_running: set[str] = set()

    async def _report_ticker() -> None:
        try:
            while True:
                await asyncio.sleep(1)
                _emit_report(set(_report_running))
        except asyncio.CancelledError:
            pass

    _report_ticker_task = asyncio.create_task(_report_ticker())
    _emit_report(set(), force=True)
    try:
        if checkpoint_source_mode:
            if len(tasks) != 1:
                raise ValueError("--checkpoint-source-index requires exactly one task")
            if args.checkpoint_source_price_limit_cents is not None:
                tasks[0].price_limit_cents = args.checkpoint_source_price_limit_cents
            result = await run_single_task(
                base_url,
                tasks[0],
                keep_failed_agents=True,
                checkpoint_source_index=args.checkpoint_source_index,
                checkpoint_source_boundary=args.checkpoint_source_boundary,
                checkpoint_source_out=Path(args.checkpoint_source_out),
                checkpoint_tree_out=Path(args.checkpoint_tree_out) if args.checkpoint_tree_out else None,
                on_agent_created=_remember_live_agent,
            )
            run.task_results.append(result)
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
                    f"\n  Running {len(exclusive_db_tasks)} destructive DB fixture task(s) before the parallel phase: {names}"
                )

            if max_concurrency is None or max_concurrency >= len(parallel_batch):
                print(f"\n  Running {len(parallel_batch)} tasks in parallel...")
            else:
                print(f"\n  Running {len(parallel_batch)} tasks in parallel (max_concurrency={max_concurrency})...")

            async def run_parallel_task(task: BenchmarkTask) -> TaskResult:
                return await run_single_task(
                    base_url,
                    task,
                    args.keep_failed_agents,
                    on_agent_created=_remember_live_agent,
                )

            pending_results: dict[asyncio.Task, BenchmarkTask] = {}
            pending: set[asyncio.Task] = set()
            try:
                for task in exclusive_db_tasks:
                    print(f"\n  Running destructive DB fixture task serially: {task.name}")
                    _report_running.clear()
                    _report_running.add(task.name)
                    result = await run_single_task(
                        base_url,
                        task,
                        args.keep_failed_agents,
                        on_agent_created=_remember_live_agent,
                    )
                    run.task_results.append(result)
                    _report_running.discard(task.name)
                    _emit_report(set())

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
                    _report_running.clear()
                    _report_running.update(pending_results[future].name for future in pending)
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
                                    progress_score=0,
                                    duration_seconds=0,
                                    cost_cents=0,
                                    message_count=0,
                                    failure_reason=str(exc),
                                )
                            )
                        else:
                            run.task_results.append(result)
                    _emit_report({pending_results[future].name for future in pending})
            except asyncio.CancelledError:
                for task_future in pending:
                    task_future.cancel()
                cancelled = await asyncio.gather(*pending, return_exceptions=True)
                for task_future, result in zip(pending, cancelled):
                    task = pending_results[task_future]
                    if isinstance(result, TaskResult):
                        run.task_results.append(result)
                    else:
                        run.task_results.append(
                            TaskResult(
                                name=task.name,
                                passed=False,
                                agent_id="",
                                status="CANCELLED",
                                progress_score=0,
                                duration_seconds=0,
                                cost_cents=0,
                                message_count=0,
                                failure_reason=f"Benchmark interrupted before task produced logs: {result}",
                            )
                        )
                raise
        else:
            for task in tasks:
                _report_running.clear()
                _report_running.add(task.name)
                result = await run_single_task(
                    base_url,
                    task,
                    args.keep_failed_agents,
                    on_agent_created=_remember_live_agent,
                )
                run.task_results.append(result)
                _report_running.discard(task.name)
                _emit_report(set())
    finally:
        _report_ticker_task.cancel()
        _emit_report(set(), force=True)
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

        # Always save results — even partial results from interrupted runs are valuable
        if run.task_results:
            run.world_model_retrieval_audit = _fetch_wmh_retrieval_audit()
            path = run.save()
            print(f"\n  Results saved: {path}")
            try:
                context_dir = Path(os.environ.get("BENCHMARK_CONTEXT_DIR", ".context"))
                context_dir.mkdir(parents=True, exist_ok=True)
                (context_dir / "run.json").write_text(Path(path).read_text(), encoding="utf-8")
            except Exception as exc:
                print(f"  ⚠ run.json archive write failed (non-fatal): {exc}")

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
        "simulate routes eligible provider/environment boundaries to WMH while agent loops and orchestration still run.",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Alias for --world-model-mode simulate. Agent loops and orchestration still run; "
        "only eligible provider/environment boundaries are simulated by WMH.",
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
    _apply_world_model_cli_env(args, parser)

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
