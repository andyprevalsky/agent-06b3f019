"""Temporal worker for Rose autonomous agents."""

import asyncio
import contextlib
import json
import logging
import os
import random
import re
import signal
import sys
from datetime import timedelta

import psutil
import structlog
from dotenv import load_dotenv
from temporalio.client import Client
from temporalio.runtime import PrometheusConfig, Runtime, TelemetryConfig
from temporalio.service import RPCError, RPCStatusCode
from temporalio.worker import (
    FixedSizeSlotSupplier,
    Worker,
    WorkerTuner,
)

# Load .env file — override=False ensures env vars inherited from run.sh
# (e.g. TEMPORAL_TASK_QUEUE derived from CONDUCTOR_WORKSPACE_NAME) take
# precedence over the static values in .env.
load_dotenv(override=False)

# Verify critical env vars
if not os.getenv("BACKEND_API_KEY"):
    print("❌ ERROR: BACKEND_API_KEY not found in environment")
    print("Please add BACKEND_API_KEY to your .env file")
    sys.exit(1)

# DAG executor activities
from activities.param_populator import populate_tool_params_activity
from browser_tools.secret_refs import redact_secret_log_values
from config import load_config
from domains.agent_messaging.service import (
    kill_agent_activity,
    list_agent_tree_activity,
    resolve_agent_address_activity,
    send_agent_message_activity,
    send_agent_message_to_address_activity,
)
from domains.api_request.repo import api_request_activity
from domains.call_phone_number.handler import call_phone_number_activity
from domains.display.repo import display_media_activity
from domains.gate.repo import (
    create_gate_request_activity,
    has_message_corpus_activity,
    mint_gmail_connect_activity,
    mint_subscription_checkout_activity,
    source_status_activity,
)
from domains.github_repo_inventory.service import fetch_github_repo_inventory_activity
from domains.grep.repo import fetch_local_data_summary, grep_activity
from domains.knowledge_base.handler import query_blueprints_activity, save_blueprint_activity
from domains.message_person.repo import (
    fetch_recent_messages_activity,
    generate_message_activity,
    queue_imessage_activity,
    read_phone_message_activity,
    send_agent_sms_activity,
    send_email_activity,
)
from domains.read_message_history.handler import read_message_history_activity
from domains.reasoning.handler import execute_reasoning_activity
from domains.report_bug.service import report_bug_activity
from domains.request_payment_card.repo import (
    agentcard_status_activity,
    lookup_purchase_activity,
    mint_purchase_card_activity,
)
from domains.request_user_approval.repo import (
    create_approval_request_activity,
    resolve_attention_request_activity,
)
from domains.spawn_agent.oai_demo_report_files import materialize_oai_demo_report_files_activity
from domains.spawn_agent.repo import fetch_explore_tool_evidence
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    fetch_full_network_metadata,
    spawn_explore_agent_activity,
)
from domains.spawn_browser_agent_v3.config import HEARTBEAT_KEEPALIVE_SECONDS
from domains.spawn_browser_agent_v3.handler import (
    drain_background_browser_cleanups,
    spawn_browser_agent_activity_v3,
)
from domains.spawn_claude_code_agent.service import (
    close_detached_code_session_activity,
    resolve_code_agent_provider_activity,
    spawn_claude_code_activity,
)
from domains.spawn_claude_code_agent.service_target import resolve_code_agent_target_activity
from domains.spawn_sub_agents.service import (
    spawn_sub_agent_activity,
    spawn_sub_agents_batch_activity,
)
from domains.user_tools.repo import resolve_user_tools_activity, run_user_tool_activity
from domains.wait_for.service import evaluate_condition_activity
from domains.web_fetch.handler import web_fetch_activity, web_fetch_download_activity
from health_server import (
    run_health_server,
    set_autoscaler_role,
    set_local_autoscaler_metrics,
    set_queue_observation,
    set_worker_status,
)
from helpers import (
    acknowledge_workflow_replacement_bootstrap,
    call_llm,
    call_llm_activity,
    check_progress,
    check_user_usage,
    compress_context,
    fetch_agent_config,
    fetch_agent_queue_pointer,
    fetch_agent_tools,
    fetch_child_terminal_result_activity,
    fetch_model_pricing,
    finalize_workflow_replacement_bootstrap,
    generate_completion_summary,
    get_model_context_window,
    get_user_context,
    get_user_custom_system_prompt,
    get_user_system_name,
    mark_finished,
    poll_new_messages,
    post_agent_message,
    resolve_fast_cache_context_activity,
    resolve_fast_cache_goal_activity,
    summarize_tool_result,
    update_agent_status,
)
from helpers.agent_graph import send_agent_graph_message_activity
from helpers.archive_identity import production_worker_interceptors
from helpers.attachments import fetch_parent_attachments_activity, resolve_attachments_activity

# Helper activities (workflow orchestration, not exposed to LLM)
from helpers.code_agent_resume_context import fetch_code_agent_resume_context
from helpers.error_alert import report_failure_activity
from helpers.generation_handoff import parse_shutdown_grace_seconds
from helpers.jev_progress import predict_jev_progress
from helpers.llm import (
    call_planner_llm_activity,
    fetch_claude_max_token_activity,
    fetch_compute_token_activity,
    fetch_gpt_code_token_activity,
    heartbeat_compute_token_lineage_activity,
    mark_claude_token_rate_limited_activity,
    mark_compute_token_rate_limited_activity,
    mark_gpt_token_rate_limited_activity,
    persist_response_schema_activity,
    release_compute_token_lineage_activity,
    set_response_schema_activity,
)
from helpers.messages import update_agent_tree_state
from helpers.process_exit import run_then_exit
from helpers.query_parent_state import query_parent_state_activity, set_temporal_client
from helpers.save_tool_usage import save_tool_usage
from helpers.sms_activities import (
    get_agent_source,
    notify_sms_event_activity,
    send_direct_sms_activity,
)
from helpers.summarize import summarize_and_filter_links
from helpers.update_tokens import apply_resume_cost_activity, update_agent_tree_cost_activity
from helpers.user_ui_activities import resolve_user_ui_inline_view_activity
from helpers.worker_activation import wait_for_worker_build_activation
from helpers.worker_event_loop import run_worker_event_loop
from helpers.worker_generation import resolve_production_task_queue
from helpers.worker_queue_capabilities import record_worker_queue_capabilities
from helpers.workflow_sandbox import production_workflow_runner
from helpers.world_model_runtime import (
    world_clock_activity,
    world_model_specialized_agent_activity,
    world_model_step_activity,
)
from temporal_connection import production_namespace_refusal, temporal_connect_options
from tools.people_search import people_search_activity  # not yet refactored into domains/
from tools.read_tool_output import preview_tool_output_activity, read_tool_output_activity
from tools.web_search import web_search_activity  # not yet refactored into domains/
from workflows import AgentWorkflow
from workflows.agent_workflow import COMPANION_WORKFLOWS

# Configure unified structured logging
# All log output (structlog + stdlib including Temporal's workflow.logger)
# goes through structlog's JSON renderer for consistent, filterable output.
#
# Temporal's workflow.logger adds a `temporal_workflow` extra dict to each
# LogRecord with {workflow_id, run_id, workflow_type, ...}. Since workflow_id
# equals agent_id, this makes all workflow logs filterable by agent_id.
# ExtraAdder captures these fields into the structured JSON output.


shared_processors = [
    structlog.contextvars.merge_contextvars,  # Injects agent_id bound via bind_contextvars()
    redact_secret_log_values,
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
]

# Configure structlog pipeline (for structlog.get_logger() callers: activities, tools)
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        *shared_processors,
        structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
)

# Bridge stdlib logging (Temporal workflow.logger, third-party libs) through structlog
formatter = structlog.stdlib.ProcessorFormatter(
    processors=[
        structlog.stdlib.ProcessorFormatter.remove_processors_meta,
        structlog.processors.JSONRenderer(),
    ],
    foreign_pre_chain=[
        structlog.stdlib.ExtraAdder(),  # Captures temporal_workflow {workflow_id=agent_id, ...}
        *shared_processors,  # shared_processors already starts with merge_contextvars
    ],
)

handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(formatter)
root_logger = logging.getLogger()
root_logger.handlers.clear()
root_logger.addHandler(handler)
root_logger.setLevel(logging.DEBUG)

# Silence verbose library logging
logging.getLogger("browser_use").setLevel(logging.INFO)
logging.getLogger("browser_use.browser").setLevel(logging.INFO)
logging.getLogger("cdp_use").setLevel(logging.WARNING)
logging.getLogger("cdp_use.client").setLevel(logging.WARNING)
logging.getLogger("cdp_use.cdp").setLevel(logging.WARNING)
logging.getLogger("cdp_use.cdp.registry").setLevel(logging.WARNING)
logging.getLogger("websockets.client").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("temporalio.activity").setLevel(logging.WARNING)
logging.getLogger("temporalio.worker").setLevel(logging.WARNING)

# Disable Temporal's default message appending (workflow details are now in structured fields)
from temporalio import workflow as _wf

_wf.logger.workflow_info_on_message = False

logger = structlog.get_logger()


import ipaddress
import math
import socket
import threading
import time
from dataclasses import dataclass

import httpx

# ── Adaptive autoscaler ──────────────────────────────────────────────────
# Built-in controller: no separate autoscaler machine needed.
# Each generation elects one leader: its lowest-IP live worker (Fly DNS plus
# each lower peer's /autoscaler/peer view). Only the leader polls Temporal (1s),
# computes the desired fleet size and actuates via the Fly Machines API.
# Followers spend no Temporal calls: they publish their own readings every
# second and mirror the leader's observation. A worker that cannot verify its
# role observes at a reduced cadence and never actuates, so a generation is
# never left without an observer.
#
# Capacity is observed in real-time from the SDK's slot metrics
# (worker_task_slots_used + worker_task_slots_available on localhost:9090).
# Admission telemetry separately reports CPU/memory pressure.
#
# Scale-up (eager):   backlog >= 20% of observed capacity → add machines
#                     or machine memory >= threshold with running workflows
# Scale-down (probe): 60s of zero backlog and no memory pressure → remove 1
#                     machine, watch for backlog
# ─────────────────────────────────────────────────────────────────────────

MIN_MACHINES = int(os.getenv("MIN_MACHINES", "2"))
MAX_MACHINES = int(os.getenv("MAX_MACHINES", "15"))  # raised from 10 to fit deep for_each trees
# Actuation gate. Prod leaves this unset → the leader actuates the Fly fleet as
# always. Per-bench cloud benchmarks set AUTOSCALER_ACTUATE=0 so the box worker
# still COMPUTES desired_machine_count (exposed via /metrics with prod's params)
# but never touches the shared bench app — run-bench-fleet is the sole actuator,
# cloning bench-queue-scoped worker machines. This keeps each bench's autoscaling
# isolated (no cross-bench leader stealing/stopping another bench's machines).
AUTOSCALER_ACTUATE = os.getenv("AUTOSCALER_ACTUATE", "1") != "0"
SCALE_DOWN_COOLDOWN_SECS = 60  # Seconds of zero backlog before probing downward
SCALE_UP_THRESHOLD = 0.2  # Fraction of machine capacity that triggers scale-up
SCALE_UP_COOLDOWN_SECS = 20  # Seconds to wait after a scale-up before allowing another
# Workflow-slot occupancy scaling. A for_each parent holds a workflow slot while it
# awaits its children, so a wide/deep fan-out can pin every workflow slot WITHOUT
# generating a Temporal backlog hint (children can't be scheduled to even enter the
# backlog). Temporal's backlog_count_hint is blind to this, so we also scale on
# observed workflow-slot occupancy. Target occupancy < 1 leaves headroom so awaiting
# parents never starve their own children of slots (the deadlock we observed).
WORKFLOW_SATURATION_SCALE_UP = float(os.getenv("WORKFLOW_SATURATION_SCALE_UP", "0.75"))
WORKFLOW_SLOT_TARGET_OCCUPANCY = float(os.getenv("WORKFLOW_SLOT_TARGET_OCCUPANCY", "0.6"))
ADMISSION_PRESSURE_SCALE_UP_SECS = 60
# Each cycle issues CountWorkflowExecutions + two DescribeTaskQueue calls. Temporal
# Cloud meters all three against the namespace's shared Visibility API budget, so
# every worker on the namespace (prod and benchmark guests alike) spends 3 calls/s
# at the 1 s default. Production keeps 1 s; isolated benchmark guests receive a
# fleet-budgeted AUTOSCALER_POLL_INTERVAL_SECONDS from their controller.
POLL_INTERVAL_SECS = 1
# A ResourceExhausted answer means the namespace budget is spent. Retrying at the
# base cadence only adds rejected load, so back off exponentially with jitter up
# to this ceiling and return to the base cadence after the next success.
AUTOSCALER_RATE_LIMIT_BACKOFF_MAX_SECS = 60.0
_AUTOSCALER_RANDOM = random.Random()
# Followers skip the three visibility calls (they cost the namespace ~3 calls/s
# per worker); only the elected leader observes. A worker that cannot verify
# whether a lower peer leads keeps observing, jittered between this and twice
# this cadence, without actuating: never zero observers, never two actuators.
AUTOSCALER_UNKNOWN_LEADER_POLL_SECS = 15.0
# A lower peer whose local readings are older than this is not provably dead
# (a wedged loop may resume actuating), so it makes leadership unknown.
AUTOSCALER_LEADER_STALE_SECS = 15.0
AUTOSCALER_PEER_PATH = "/autoscaler/peer"
AUTOSCALER_ROLE_LEADER = "leader"
AUTOSCALER_ROLE_FOLLOWER = "follower"
AUTOSCALER_ROLE_UNKNOWN = "unknown"
PEER_PROBE_TIMEOUT_SECS = 1.0
# Local memory/admission/slot readings publish on their own cadence: peers'
# leader decisions and the scale-down idle guard read them even while the
# namespace throttles visibility calls.
LOCAL_TELEMETRY_INTERVAL_SECS = 1.0
METRICS_RPC_TIMEOUT = timedelta(seconds=5)
LOG_INTERVAL_SECS = 30  # Periodic summary log (avoid 86k lines/day at 1s polls)
SDK_METRICS_PORT = int(os.getenv("SDK_METRICS_PORT", "9090"))
HEALTH_CHECK_PORT = int(os.getenv("HEALTH_CHECK_PORT", "8080"))
DEFAULT_CAPACITY = 100  # Fallback when SDK metrics are unavailable (matches default max activity slots)
MEMORY_SCALE_UP_THRESHOLD_PERCENT = float(os.getenv("MEMORY_SCALE_UP_THRESHOLD_PERCENT", "75"))

FLY_MACHINES_API = "https://api.machines.dev/v1"

# Mutable state (single writer in poll loop)
_backlog_zero_since: float | None = None
_desired_machines: int = MIN_MACHINES
_last_log_time: float = 0
_last_scale_up_time: float = 0
_prev_desired: int = MIN_MACHINES
_admission_pressure_since: float | None = None
_latest_local_telemetry: dict | None = None


class ActivityAdmissionSnapshot:
    """Passive memory-admission telemetry for autoscaler decisions.

    Do not implement this as a Temporal CustomSlotSupplier. Temporal invokes
    custom slot supplier callbacks from Rust runtime threads, and those
    callbacks must reacquire the Python GIL. Under activity heartbeat traffic,
    that can deadlock the worker before it polls new workflow tasks.
    """

    def __init__(
        self,
        *,
        maximum_slots: int,
        close_memory_percent: float,
        open_memory_percent: float,
        close_cpu_percent: float = 85.0,
        open_cpu_percent: float = 70.0,
        poll_interval_s: float = 0.1,
    ) -> None:
        if open_memory_percent >= close_memory_percent:
            raise ValueError("ACTIVITY_ADMISSION_OPEN_MEMORY_PERCENT must be below close threshold")
        if open_cpu_percent >= close_cpu_percent:
            raise ValueError("ACTIVITY_ADMISSION_OPEN_CPU_PERCENT must be below close threshold")
        self.maximum_slots = maximum_slots
        self.close_memory_percent = close_memory_percent
        self.open_memory_percent = open_memory_percent
        self.close_cpu_percent = close_cpu_percent
        self.open_cpu_percent = open_cpu_percent
        self._admission_open = True
        self._memory_percent = 0.0
        self._cpu_percent = 0.0
        # Prime psutil's system-wide CPU sampler so the first real read measures
        # the interval since construction rather than returning 0.0.
        psutil.cpu_percent(None)

    def _refresh_admission(self) -> None:
        self._memory_percent = float(psutil.virtual_memory().percent)
        # System-wide CPU over the interval since the last poll (non-blocking).
        # On a 1-vCPU Fly VM this is the guest core's utilization — the direct
        # signal for GIL/event-loop saturation from concurrent agent activities.
        self._cpu_percent = float(psutil.cpu_percent(None))
        # Close on EITHER pressure; only reopen when BOTH have recovered, so a
        # still-pegged core can't flap admission back open on a memory dip.
        under_close = self._memory_percent >= self.close_memory_percent or self._cpu_percent >= self.close_cpu_percent
        under_open = self._memory_percent <= self.open_memory_percent and self._cpu_percent <= self.open_cpu_percent
        if self._admission_open and under_close:
            self._admission_open = False
        elif not self._admission_open and under_open:
            self._admission_open = True

    def snapshot(self) -> dict[str, int | float | bool]:
        self._refresh_admission()
        return {
            "activity_admission_open": self._admission_open,
            "activity_admission_memory_percent": self._memory_percent,
            "activity_admission_close_memory_percent": self.close_memory_percent,
            "activity_admission_open_memory_percent": self.open_memory_percent,
            "activity_admission_cpu_percent": self._cpu_percent,
            "activity_admission_close_cpu_percent": self.close_cpu_percent,
            "activity_admission_open_cpu_percent": self.open_cpu_percent,
            "activity_admission_max_slots": self.maximum_slots,
        }


def _canonical_ip(ip: str) -> str:
    """Canonical text form of an address.

    Leadership keeps the established order (sorted canonical text), so workers
    on old and new code agree on the lowest peer during a rolling deploy; this
    only protects equality and order against a non-canonical FLY_PRIVATE_IP.
    """
    value = (ip or "").strip()
    try:
        return str(ipaddress.ip_address(value.split("%", 1)[0]))
    except ValueError:
        return value.lower()


def _get_peer_ips(app_name: str) -> list[str]:
    """Get sorted list of all peer IPv6 addresses via Fly internal DNS."""
    try:
        addrs = socket.getaddrinfo(f"{app_name}.internal", None, socket.AF_INET6)
    except socket.gaierror:
        return []
    return sorted({_canonical_ip(a[4][0]) for a in addrs})


@dataclass(frozen=True)
class AutoscalerRole:
    """This worker's autoscaler role for one cycle."""

    role: str
    reason: str
    peers: tuple[str, ...] = ()
    self_ip: str | None = None
    leader_ip: str | None = None
    leader_view: dict | None = None


def _worker_surface_hash() -> str:
    return (os.getenv("TEMPORAL_WORKER_SURFACE_HASH") or "").strip()


async def _probe_autoscaler_peer(http: httpx.AsyncClient, ip: str) -> dict | None:
    """Return one peer's /autoscaler/peer view, or None when it cannot be verified."""
    try:
        resp = await http.get(
            f"http://[{ip}]:{HEALTH_CHECK_PORT}{AUTOSCALER_PEER_PATH}",
            timeout=PEER_PROBE_TIMEOUT_SECS,
        )
        if resp.status_code != 200:
            return None
        view = resp.json()
    except Exception as e:
        logger.debug("Failed to read peer autoscaler view", peer_ip=ip, error=str(e))
        return None
    return view if isinstance(view, dict) else None


def _peer_candidacy(view: dict | None, surface: str) -> bool | None:
    """True: a live leader candidate of this generation; False: provably not; None: unverifiable."""
    if view is None:
        return None  # unreachable, slow, or pre-upgrade: it may still be leading
    if str(view.get("surface_hash") or "").strip() != surface:
        return False  # another generation polls its own queue and actuates its own machines
    if view.get("leader_eligible") is not True:
        return False  # standby, opted out, compute-only, or its observer loop has exited
    age = view.get("heartbeat_age_seconds")
    if isinstance(age, bool) or not isinstance(age, int | float) or not math.isfinite(age):
        return None
    if age > AUTOSCALER_LEADER_STALE_SECS:
        return None  # a wedged loop is not provably dead
    return True


async def _resolve_autoscaler_role(http: httpx.AsyncClient, stop_event: asyncio.Event) -> AutoscalerRole:
    """Deterministic per-generation leader: the lowest-IP live worker of this generation.

    Probes lower peers in ascending order and stops at the first live
    same-generation candidate, so a follower usually reads one peer and the
    leader reads none. If DNS, this worker's address or any lower peer cannot
    be verified, the role is unknown: observe at a reduced cadence, never
    actuate. Off Fly (local dev, isolated benchmark guests) the worker is alone.
    """
    fly_app = os.getenv("FLY_APP_NAME")
    if not fly_app:
        return AutoscalerRole(AUTOSCALER_ROLE_LEADER, "not_on_fly")
    my_ip = _canonical_ip(os.getenv("FLY_PRIVATE_IP") or "")
    if not my_ip:
        return AutoscalerRole(AUTOSCALER_ROLE_UNKNOWN, "missing_private_ip")
    peers = tuple(sorted({_canonical_ip(ip) for ip in _get_peer_ips(fly_app)}))
    if not peers:
        return AutoscalerRole(AUTOSCALER_ROLE_UNKNOWN, "peer_dns_unavailable", self_ip=my_ip)
    surface = _worker_surface_hash()
    unverified = False
    for ip in peers:
        if ip >= my_ip:
            break
        if stop_event.is_set():
            return AutoscalerRole(AUTOSCALER_ROLE_UNKNOWN, "stopping", peers, my_ip)
        view = await _probe_autoscaler_peer(http, ip)
        candidacy = _peer_candidacy(view, surface)
        if candidacy is True:
            return AutoscalerRole(AUTOSCALER_ROLE_FOLLOWER, "lower_live_peer", peers, my_ip, ip, view)
        unverified = unverified or candidacy is None
    if unverified:
        return AutoscalerRole(AUTOSCALER_ROLE_UNKNOWN, "lower_peer_unverified", peers, my_ip)
    return AutoscalerRole(AUTOSCALER_ROLE_LEADER, "lowest_live_peer", peers, my_ip)


async def _scrape_fleet_peer_views(
    http: httpx.AsyncClient,
    peer_ips: list[str],
    stop_event: asyncio.Event | None = None,
) -> dict[str, dict | None]:
    """Leader-only: read every peer's view concurrently, bounded by one probe timeout."""

    async def probe(ip: str) -> tuple[str, dict | None]:
        if stop_event is not None and stop_event.is_set():
            return ip, None
        return ip, await _probe_autoscaler_peer(http, ip)

    return dict(await asyncio.gather(*(probe(ip) for ip in peer_ips)))


@dataclass(frozen=True)
class FleetReadings:
    current_machines: int
    memory_used_percent: float
    admission_unavailable_count: int


def _summarize_fleet(
    role: AutoscalerRole,
    views: dict[str, dict | None],
    *,
    local_memory_used_percent: float,
    local_activity_admission_open: bool,
) -> FleetReadings:
    """Aggregate this generation's fleet. Unverified peers still count as machines
    (as DNS always did); a peer that proves another generation does not."""
    surface = _worker_surface_hash()
    foreign = {
        ip for ip, view in views.items() if view is not None and str(view.get("surface_hash") or "").strip() != surface
    }
    same_generation = [view for ip, view in views.items() if view is not None and ip not in foreign]
    current_machines = max(1, len([ip for ip in role.peers if ip not in foreign]))
    memory_samples = [local_memory_used_percent]
    unavailable = 0 if local_activity_admission_open else 1
    for view in same_generation:
        memory = view.get("machine_memory_used_percent")
        if isinstance(memory, int | float) and not isinstance(memory, bool) and math.isfinite(memory):
            memory_samples.append(float(memory))
        if view.get("activity_admission_open") is False:
            unavailable += 1
    return FleetReadings(current_machines, max(memory_samples), min(unavailable, current_machines))


def _parse_prometheus_sample(line: str) -> tuple[str, dict[str, str], float] | None:
    """Parse one simple Prometheus text exposition sample."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.rsplit(None, 1)
    if len(parts) != 2:
        return None
    sample, value_raw = parts
    try:
        value = float(value_raw)
    except ValueError:
        return None
    if "{" not in sample:
        return sample, {}, value
    name, rest = sample.split("{", 1)
    labels_raw = rest.rsplit("}", 1)[0]
    labels = dict(re.findall(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"', labels_raw))
    return name, labels, value


async def _get_sdk_worker_metrics(http: httpx.AsyncClient) -> dict[str, int | float | None] | None:
    """Read raw Temporal SDK worker/tuner metrics from the Prometheus endpoint."""
    try:
        resp = await http.get(f"http://localhost:{SDK_METRICS_PORT}/metrics", timeout=2.0)

        slots_used: int | None = None
        slots_available: int | None = None
        metrics: dict[str, int | float | None] = {
            "resource_slots_cpu_usage": None,
            "resource_slots_mem_usage": None,
            "resource_slots_cpu_pid_output": None,
            "resource_slots_mem_pid_output": None,
            "activity_task_pollers": None,
            "workflow_task_pollers": None,
            "sticky_workflow_task_pollers": None,
        }
        for line in resp.text.splitlines():
            sample = _parse_prometheus_sample(line)
            if sample is None:
                continue
            name, labels, value = sample
            if name == "temporal_resource_slots_cpu_usage":
                metrics["resource_slots_cpu_usage"] = value
                continue
            if name == "temporal_resource_slots_mem_usage":
                metrics["resource_slots_mem_usage"] = value
                continue
            if name == "temporal_resource_slots_cpu_pid_output":
                metrics["resource_slots_cpu_pid_output"] = value
                continue
            if name == "temporal_resource_slots_mem_pid_output":
                metrics["resource_slots_mem_pid_output"] = value
                continue
            if name == "temporal_num_pollers":
                poller_type = labels.get("poller_type")
                if poller_type == "activity_task":
                    metrics["activity_task_pollers"] = int(value)
                elif poller_type == "workflow_task":
                    metrics["workflow_task_pollers"] = int(value)
                elif poller_type == "sticky_workflow_task":
                    metrics["sticky_workflow_task_pollers"] = int(value)
                continue

            has_activity_worker = labels.get("worker_type") == "ActivityWorker"
            has_activity_task = labels.get("task_type") == "ActivityTask"
            if not has_activity_worker and not has_activity_task:
                continue
            if name in {"temporal_worker_task_slots_used", "worker_task_slots_used", "task_slots_used"}:
                slots_used = int(value)
            elif name in {
                "temporal_worker_task_slots_available",
                "worker_task_slots_available",
                "task_slots_available",
            }:
                slots_available = int(value)

        metrics["activity_slots_used"] = slots_used
        metrics["activity_slots_available"] = slots_available
        return metrics if any(value is not None for value in metrics.values()) else None
    except Exception as e:
        logger.warning("Failed to read SDK metrics", error=str(e))
        return None


async def _get_observed_capacity(http: httpx.AsyncClient) -> int | None:
    """Read effective activity capacity from SDK slot metrics."""
    metrics = await _get_sdk_worker_metrics(http)
    if metrics is None:
        return None
    slots_used = metrics.get("activity_slots_used")
    slots_available = metrics.get("activity_slots_available")
    if slots_available is None:
        return None
    if slots_used is None:
        slots_used = 0
    return max(int(slots_used) + int(slots_available), 1)


def _get_machine_memory_used_percent() -> float:
    """Return memory usage percentage visible from inside this Fly Machine."""
    try:
        return float(psutil.virtual_memory().percent)
    except Exception as e:
        logger.warning("Failed to read machine memory percent", error=str(e))
        return 0.0


def _extract_metric_value(metrics_text: str, metric_name: str) -> float | None:
    """Extract a numeric Prometheus gauge value from a metrics payload."""
    for line in metrics_text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) == 2 and parts[0] == metric_name:
            try:
                return float(parts[1])
            except ValueError:
                return None
    return None


def _activity_admission_scale_threshold(current_machines: int) -> int:
    if current_machines <= 3:
        return 1
    return max(2, math.ceil(current_machines * 0.20))


async def _machine_in_flight_activities(machine: dict, http: httpx.AsyncClient) -> int | None:
    """Return the activity slots in use on a peer machine, or None when unknown."""
    ip = str(machine.get("private_ip") or "").strip()
    if not ip:
        return None
    try:
        resp = await http.get(f"http://[{ip}]:{HEALTH_CHECK_PORT}/metrics", timeout=1.0)
        if resp.status_code != 200:
            return None
        value = _extract_metric_value(resp.text, "activity_slots_used")
    except Exception as e:
        logger.debug("Failed to scrape peer activity slots", machine_id=machine.get("id"), error=str(e))
        return None
    if value is None or math.isnan(value):
        return None
    return int(value)


async def _idle_stop_candidates(candidates: list[dict], http: httpx.AsyncClient) -> tuple[list[dict], list[dict]]:
    """Split stop candidates into (idle, busy_or_unknown).

    Stopping a machine SIGTERMs its worker, and in-flight activities that
    outlive the 5m shutdown grace (30m browser, claude-code) die with a
    heartbeat timeout. Only machines that report zero in-flight activities are
    safe to stop; an unknown count is treated as busy.
    """
    counts = await asyncio.gather(*(_machine_in_flight_activities(m, http) for m in candidates))
    idle: list[dict] = []
    busy: list[dict] = []
    for machine, count in zip(candidates, counts, strict=True):
        (idle if count == 0 else busy).append(machine)
    return idle, busy


async def _scale_fleet(desired: int, http: httpx.AsyncClient, stop_event: asyncio.Event | None = None):
    """Start/stop Fly machines to reach desired count. Called by leader only.

    Machines must be pre-provisioned up to MAX_MACHINES (e.g. `fly scale count 10`).
    This function starts/stops existing machines — it does not create or destroy them.
    """
    if stop_event is not None and stop_event.is_set():
        return
    fly_app = os.getenv("FLY_APP_NAME")
    fly_token = os.getenv("FLY_API_TOKEN")
    if not fly_app or not fly_token:
        return

    my_machine_id = os.getenv("FLY_MACHINE_ID")
    headers = {"Authorization": f"Bearer {fly_token}"}

    try:
        resp = await http.get(
            f"{FLY_MACHINES_API}/apps/{fly_app}/machines",
            headers=headers,
        )
        if stop_event is not None and stop_event.is_set():
            return
        resp.raise_for_status()
        machines = resp.json()

        my_surface = (os.getenv("TEMPORAL_WORKER_SURFACE_HASH") or "").strip()

        def _machine_surface(machine: dict) -> str:
            env = (machine.get("config") or {}).get("env") or {}
            return str(env.get("TEMPORAL_WORKER_SURFACE_HASH") or "").strip()

        # Overlapping generations share one Fly app. Only actuate machines that
        # belong to this worker's surface hash so a new-gen leader cannot stop
        # old-gen pollers mid cooperative drain.
        if my_surface:
            machines = [m for m in machines if _machine_surface(m) == my_surface]

        # A retained generation can share this surface again after a rollback.
        # Its stopped pool entries need leased custody reuse before any start.
        def _owned_active_pool(machine: dict) -> bool:
            config = machine.get("config") or {}
            metadata = config.get("metadata") or {}
            if metadata.get("rose_worker_reuse_protected"):
                return False
            if "rose_cooperative_worker_pool" not in metadata:
                return True
            try:
                pool = json.loads(metadata["rose_cooperative_worker_pool"])
            except (TypeError, ValueError):
                return False
            env = config.get("env") or {}
            actual_attempt = {
                "build": env.get("TEMPORAL_WORKER_BUILD_ID"),
                "token": env.get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN"),
            }
            return isinstance(pool, dict) and all(
                (
                    pool.get("version") == 1,
                    pool.get("phase") == "active",
                    pool.get("app") == fly_app,
                    pool.get("id") == machine.get("id"),
                    pool.get("hash") == env.get("TEMPORAL_WORKER_SURFACE_HASH"),
                    bool(actual_attempt["build"]),
                    bool(actual_attempt["token"]),
                    (
                        all(pool.get(key) == value for key, value in actual_attempt.items())
                        or pool.get("rolling") == actual_attempt
                    ),
                )
            )

        machines = [m for m in machines if _owned_active_pool(m)]
        started = [m for m in machines if m["state"] == "started"]
        stopped = [m for m in machines if m["state"] == "stopped"]
        # Same-surface rolling deploys leave stopped old images untouched.
        # Only the running build/attempt may admit a stopped peer back to work.
        if my_surface:
            current_build = os.getenv("TEMPORAL_WORKER_BUILD_ID")
            current_token = os.getenv("TEMPORAL_WORKER_DEPLOYMENT_TOKEN")
            stopped = [
                m
                for m in stopped
                if current_build
                and current_token
                and (m.get("config", {}).get("env") or {}).get("TEMPORAL_WORKER_BUILD_ID") == current_build
                and (m.get("config", {}).get("env") or {}).get("TEMPORAL_WORKER_DEPLOYMENT_TOKEN") == current_token
            ]
        current = len(started)

        if desired > current and stopped:
            to_start = min(desired - current, len(stopped))
            for m in stopped[:to_start]:
                if stop_event is not None and stop_event.is_set():
                    return
                try:
                    await http.post(
                        f"{FLY_MACHINES_API}/apps/{fly_app}/machines/{m['id']}/start",
                        headers=headers,
                    )
                    logger.info("Autoscaler: started machine", machine_id=m["id"])
                except Exception as e:
                    logger.warning("Autoscaler: failed to start machine", machine_id=m["id"], error=str(e))

        elif desired < current:
            to_stop = current - desired
            candidates = [m for m in started if m["id"] != my_machine_id]
            idle, busy = await _idle_stop_candidates(candidates, http)
            if len(idle) < to_stop:
                logger.info(
                    "Autoscaler: deferring scale-down of busy machines",
                    wanted_to_stop=to_stop,
                    idle_machines=len(idle),
                    busy_machine_ids=[m["id"] for m in busy],
                )
            for m in idle[:to_stop]:
                if stop_event is not None and stop_event.is_set():
                    return
                try:
                    await http.post(
                        f"{FLY_MACHINES_API}/apps/{fly_app}/machines/{m['id']}/stop",
                        headers=headers,
                    )
                    logger.info("Autoscaler: stopped machine", machine_id=m["id"])
                except Exception as e:
                    logger.warning("Autoscaler: failed to stop machine", machine_id=m["id"], error=str(e))
    except Exception as e:
        logger.warning("Autoscaler: fleet list failed", error=str(e))


def _autoscaler_poll_interval_seconds() -> float:
    """Base observation cadence; invalid or non-positive values keep the 1 s default."""
    try:
        value = float(os.getenv("AUTOSCALER_POLL_INTERVAL_SECONDS", str(POLL_INTERVAL_SECS)))
    except ValueError:
        return float(POLL_INTERVAL_SECS)
    return value if value > 0 and math.isfinite(value) else float(POLL_INTERVAL_SECS)


def _autoscaler_queue_metrics_enabled() -> bool:
    """Workers whose desired count nobody consumes (benchmark worker clones) opt out."""
    return os.getenv("AUTOSCALER_QUEUE_METRICS", "1") != "0"


def _is_rate_limited(error: BaseException) -> bool:
    return isinstance(error, RPCError) and error.status == RPCStatusCode.RESOURCE_EXHAUSTED


def _autoscaler_retry_delay(base_seconds: float, consecutive_rate_limits: int) -> float:
    """Full-jitter exponential delay after consecutive ResourceExhausted cycles."""
    if consecutive_rate_limits <= 0:
        return base_seconds
    ceiling = max(base_seconds, AUTOSCALER_RATE_LIMIT_BACKOFF_MAX_SECS)
    upper = min(ceiling, base_seconds * (2 ** min(consecutive_rate_limits, 16)))
    return _AUTOSCALER_RANDOM.uniform(base_seconds, upper)


@dataclass(frozen=True)
class QueueObservation:
    workflow_count: int
    backlog: int


async def _observe_task_queue(
    client: Client,
    namespace: str,
    task_queue: str,
    stop_event: asyncio.Event,
) -> tuple[QueueObservation | None, BaseException | None]:
    """One complete observation (1 CountWorkflowExecutions + 2 DescribeTaskQueue).

    Any failed call makes the whole observation unknown and ends the cycle: a
    missing backlog is not a zero backlog, and a throttled namespace should not
    be sent the remaining calls.
    """
    from temporalio.api.enums.v1 import TaskQueueType
    from temporalio.api.taskqueue.v1 import TaskQueue as TaskQueueProto
    from temporalio.api.workflowservice.v1 import CountWorkflowExecutionsRequest, DescribeTaskQueueRequest

    try:
        # This loop owns retries. The high-level count_workflows call retries
        # internally, so its per-attempt deadline does not bound shutdown when
        # a namespace keeps returning RESOURCE_EXHAUSTED.
        count_result = await client.workflow_service.count_workflow_executions(
            CountWorkflowExecutionsRequest(
                namespace=namespace,
                query=f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"',
            ),
            retry=False,
            timeout=METRICS_RPC_TIMEOUT,
        )
        if stop_event.is_set():
            return None, None
        backlog = 0
        for task_type in [TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY, TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW]:
            resp = await client.workflow_service.describe_task_queue(
                DescribeTaskQueueRequest(
                    namespace=namespace,
                    task_queue=TaskQueueProto(name=task_queue),
                    task_queue_type=task_type,
                ),
                retry=False,
                timeout=METRICS_RPC_TIMEOUT,
            )
            if resp.task_queue_status:
                backlog += resp.task_queue_status.backlog_count_hint
            if stop_event.is_set():
                return None, None
        return QueueObservation(workflow_count=int(count_result.count), backlog=int(backlog)), None
    except Exception as e:
        return None, e


async def _publish_local_autoscaler_metrics(
    http: httpx.AsyncClient,
    activity_admission_snapshot: ActivityAdmissionSnapshot,
) -> dict:
    """Read and publish this machine's own readings (no Temporal call)."""
    global _latest_local_telemetry
    # Some SDK builds expose slots_used but not slots_available; keep missing
    # values as None so diagnostics do not confuse unknown with zero.
    sdk_metrics = await _get_sdk_worker_metrics(http) or {}
    activity_slots_used = sdk_metrics.get("activity_slots_used")
    activity_slots_available = sdk_metrics.get("activity_slots_available")
    observed_capacity = (
        max(int(activity_slots_used or 0) + int(activity_slots_available), 1)
        if activity_slots_available is not None
        else None
    )
    memory_used_percent = _get_machine_memory_used_percent()
    admission = activity_admission_snapshot.snapshot()
    set_local_autoscaler_metrics(
        machine_memory_used_percent=memory_used_percent,
        observed_capacity=observed_capacity,
        activity_slots_used=activity_slots_used,
        activity_slots_available=activity_slots_available,
        resource_slots_cpu_usage=sdk_metrics.get("resource_slots_cpu_usage"),
        resource_slots_mem_usage=sdk_metrics.get("resource_slots_mem_usage"),
        resource_slots_cpu_pid_output=sdk_metrics.get("resource_slots_cpu_pid_output"),
        resource_slots_mem_pid_output=sdk_metrics.get("resource_slots_mem_pid_output"),
        activity_task_pollers=sdk_metrics.get("activity_task_pollers"),
        workflow_task_pollers=sdk_metrics.get("workflow_task_pollers"),
        sticky_workflow_task_pollers=sdk_metrics.get("sticky_workflow_task_pollers"),
        activity_admission_open=bool(admission["activity_admission_open"]),
        activity_admission_memory_percent=float(admission["activity_admission_memory_percent"]),
        activity_admission_close_memory_percent=float(admission["activity_admission_close_memory_percent"]),
        activity_admission_open_memory_percent=float(admission["activity_admission_open_memory_percent"]),
    )
    _latest_local_telemetry = {
        "sdk_metrics": sdk_metrics,
        "observed_capacity": observed_capacity,
        "memory_used_percent": memory_used_percent,
        "admission": admission,
    }
    return _latest_local_telemetry


async def _run_local_autoscaler_publisher(
    http: httpx.AsyncClient,
    activity_admission_snapshot: ActivityAdmissionSnapshot,
    stop_event: asyncio.Event,
) -> None:
    """Keep local readings (and this worker's election heartbeat) fresh every second."""
    while not stop_event.is_set():
        await asyncio.sleep(LOCAL_TELEMETRY_INTERVAL_SECS)
        if stop_event.is_set():
            return
        try:
            await _publish_local_autoscaler_metrics(http, activity_admission_snapshot)
        except Exception as e:
            logger.warning("Failed to publish local autoscaler readings", error=str(e))


def _mirror_leader_observation(role: AutoscalerRole) -> None:
    """Publish the leader's own observation on a follower, or unknown."""
    queue = (role.leader_view or {}).get("queue")
    if isinstance(queue, dict) and queue.get("source") == "self":
        try:
            set_queue_observation(
                int(queue["backlog"]),
                int(queue["workflow_count"]),
                desired_machines=int(queue["desired_machines"]),
                current_machines=int(queue["current_machines"]),
                age_seconds=float(queue.get("age_seconds") or 0.0),
                source="leader",
            )
            return
        except (KeyError, TypeError, ValueError):
            pass
    set_queue_observation(None, None, desired_machines=_desired_machines, current_machines=max(1, len(role.peers)))


async def poll_queue_metrics(
    client: Client,
    namespace: str,
    task_queue: str,
    activity_admission_snapshot: ActivityAdmissionSnapshot,
    max_workflow_slots: int,
    stop_event: asyncio.Event,
):
    """Adaptive autoscaler: elect, observe Temporal (leader only), decide, actuate via Fly API.

    Every worker publishes its own memory/admission/slot readings each second,
    independently of Temporal. Each cycle it resolves its role (see
    _resolve_autoscaler_role). Only the leader spends the three Temporal
    visibility calls, aggregates its generation's peer readings, computes
    desired_machine_count and actuates. Followers mirror the leader's
    observation. An unverified role observes every 15-30 s and never actuates.
    Compute-only workers (AUTOSCALER_ACTUATE=0, e.g. benchmark guests) keep
    observing at their own cadence: an external controller reads that machine.

    Scale-up (eager):
      Capacity is observed in real-time from the SDK's slot metrics
      (worker_task_slots_used + worker_task_slots_available on localhost:9090).
      When backlog >= 20% of observed capacity, add ceil(backlog / capacity) machines.
      The 20% threshold absorbs transient blips; ceil() ensures we add enough
      machines once the threshold is crossed (0.2→+1, 1.2→+2).
      Memory pressure is an independent signal: when the fleet is above
      MEMORY_SCALE_UP_THRESHOLD_PERCENT and workflows are running, hold the
      current machine count (block scale-down). Backlog can be 0 while
      activities are already in-flight and consuming memory, so backlog alone
      is not a sufficient saturation signal.

    Scale-down (adaptive):
      When backlog stays at 0 for 60 consecutive seconds:
      - If no workflows running → go straight to MIN_MACHINES (fast drain)
      - If workflows still running → remove 1 machine and probe again after 60s
      If removing a machine causes backlog, we detect it within 1s and scale back up.
      Memory pressure blocks scale-down. An unknown backlog never counts as zero.

    No separate autoscaler machine needed — the navi-whisper-lux-autoscaler app
    can be decommissioned.
    """
    global _admission_pressure_since, _backlog_zero_since

    async with httpx.AsyncClient(timeout=10.0) as http:
        # Local readings first and independently of Temporal: the leader's fleet
        # view and its scale-down idle guard read them even under throttling.
        try:
            await _publish_local_autoscaler_metrics(http, activity_admission_snapshot)
        except Exception as e:
            logger.warning("Failed to publish local autoscaler readings", error=str(e))
        publisher = asyncio.create_task(_run_local_autoscaler_publisher(http, activity_admission_snapshot, stop_event))
        last_role: str | None = None
        try:
            if not _autoscaler_queue_metrics_enabled():
                # Nobody reads this worker's desired count; spending the namespace's
                # shared Visibility API budget on it only throttles workers that do.
                logger.info("Autoscaler queue observation disabled for this worker", task_queue=task_queue)
                set_autoscaler_role(None, leader_eligible=False, observes_queue=False)
                await stop_event.wait()
                return

            poll_interval = _autoscaler_poll_interval_seconds()
            consecutive_rate_limits = 0
            # Compute-only workers observe for an external reader; they are never
            # an actuating fleet's leader and never defer to one.
            independent = not AUTOSCALER_ACTUATE
            set_autoscaler_role(None, leader_eligible=AUTOSCALER_ACTUATE, observes_queue=False)
            if poll_interval > POLL_INTERVAL_SECS:
                # Budgeted guests start together behind one release barrier. A random
                # phase spreads their first observations across one interval instead
                # of aligning every guest's calls on the same second.
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(stop_event.wait(), timeout=_AUTOSCALER_RANDOM.uniform(0, poll_interval))

            while not stop_event.is_set():
                next_delay = poll_interval
                try:
                    role = await _resolve_autoscaler_role(http, stop_event)
                    if stop_event.is_set():
                        return
                    observes = independent or role.role != AUTOSCALER_ROLE_FOLLOWER
                    set_autoscaler_role(role.role, leader_eligible=AUTOSCALER_ACTUATE, observes_queue=observes)
                    if role.role != last_role:
                        logger.info(
                            "Autoscaler role",
                            role=role.role,
                            reason=role.reason,
                            leader_ip=role.leader_ip,
                            observes_queue=observes,
                            peers=len(role.peers),
                        )
                        last_role = role.role
                    if role.role != AUTOSCALER_ROLE_LEADER and not independent:
                        # Only the leader's decision drives scaling; keep no
                        # decision window that a later promotion could act on.
                        _backlog_zero_since = None
                        _admission_pressure_since = None

                    if not observes:
                        consecutive_rate_limits = 0
                        _mirror_leader_observation(role)
                    else:
                        cadence = (
                            poll_interval
                            if independent or role.role == AUTOSCALER_ROLE_LEADER
                            else max(poll_interval, AUTOSCALER_UNKNOWN_LEADER_POLL_SECS)
                        )
                        observation, error = await _observe_task_queue(client, namespace, task_queue, stop_event)
                        if stop_event.is_set():
                            return
                        if observation is None:
                            # Unknown, not zero: hold, and require a fresh run of
                            # observed zero backlog before any scale-down probe.
                            _backlog_zero_since = None
                            set_queue_observation(
                                None,
                                None,
                                desired_machines=_desired_machines,
                                current_machines=max(1, len(role.peers)),
                            )
                            if error is not None and _is_rate_limited(error):
                                consecutive_rate_limits += 1
                                next_delay = _autoscaler_retry_delay(cadence, consecutive_rate_limits)
                                logger.warning(
                                    "Failed to poll queue metrics",
                                    error=str(error),
                                    consecutive_rate_limits=consecutive_rate_limits,
                                    retry_in_seconds=round(next_delay, 3),
                                )
                            else:
                                if error is not None:
                                    logger.warning("Failed to poll queue metrics", error=str(error))
                                next_delay = cadence
                        else:
                            consecutive_rate_limits = 0
                            next_delay = (
                                cadence
                                if cadence == poll_interval
                                else _AUTOSCALER_RANDOM.uniform(cadence, 2 * cadence)
                            )
                            await _decide_and_actuate(
                                http,
                                role,
                                observation,
                                max_workflow_slots=max_workflow_slots,
                                stop_event=stop_event,
                            )
                            if stop_event.is_set():
                                return
                except Exception as e:
                    logger.warning("Autoscaler cycle failed", error=str(e))

                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=next_delay)
                except asyncio.TimeoutError:
                    pass
        finally:
            # A stopped observer must never remain the peer others defer to.
            set_autoscaler_role(last_role, leader_eligible=False, observes_queue=False)
            publisher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await publisher


async def _decide_and_actuate(
    http: httpx.AsyncClient,
    role: AutoscalerRole,
    observation: QueueObservation,
    *,
    max_workflow_slots: int,
    stop_event: asyncio.Event,
) -> None:
    """Compute desired_machine_count from a fresh observation; the leader actuates."""
    global \
        _admission_pressure_since, \
        _backlog_zero_since, \
        _desired_machines, \
        _last_log_time, \
        _last_scale_up_time, \
        _prev_desired

    workflow_count = observation.workflow_count
    backlog = observation.backlog
    local = _latest_local_telemetry or {}
    sdk_metrics = local.get("sdk_metrics") or {}
    admission_snapshot = local.get("admission") or {}
    observed_capacity = local.get("observed_capacity")
    scale_capacity_source = "sdk_slots" if observed_capacity is not None else "fallback_missing_sdk_available_slots"
    memory_used_percent = float(local.get("memory_used_percent") or _get_machine_memory_used_percent())
    activity_admission_open = bool(admission_snapshot.get("activity_admission_open", True))

    if role.role == AUTOSCALER_ROLE_LEADER and role.self_ip is not None:
        # Leader only: one concurrent view read per peer replaces every
        # worker's two sequential /metrics scrapes of every peer.
        views = await _scrape_fleet_peer_views(http, [ip for ip in role.peers if ip != role.self_ip], stop_event)
        if stop_event.is_set():
            return
        fleet = _summarize_fleet(
            role,
            views,
            local_memory_used_percent=memory_used_percent,
            local_activity_admission_open=activity_admission_open,
        )
    else:
        fleet = FleetReadings(
            current_machines=max(1, len(role.peers)),
            memory_used_percent=memory_used_percent,
            admission_unavailable_count=0 if activity_admission_open else 1,
        )
    current_machines = fleet.current_machines
    fleet_memory_used_percent = fleet.memory_used_percent
    memory_pressure = fleet_memory_used_percent >= MEMORY_SCALE_UP_THRESHOLD_PERCENT
    activity_admission_unavailable_count = fleet.admission_unavailable_count
    activity_admission_scale_threshold = _activity_admission_scale_threshold(current_machines)

    # ── Adaptive scaling decision ─────────────────────────────
    now = time.monotonic()
    in_cooldown = (now - _last_scale_up_time) < SCALE_UP_COOLDOWN_SECS
    admission_pressure = (
        workflow_count > 0 and activity_admission_unavailable_count >= activity_admission_scale_threshold
    )
    if admission_pressure:
        if _admission_pressure_since is None:
            _admission_pressure_since = now
    else:
        _admission_pressure_since = None
    admission_pressure_seconds = 0.0 if _admission_pressure_since is None else now - _admission_pressure_since
    # Workflow-slot occupancy: a for_each parent holds a workflow slot while
    # awaiting its children, so a deep/wide fan-out can pin every workflow slot
    # with ZERO Temporal backlog hint (the children can't be scheduled to even
    # enter the backlog). Scale on observed occupancy too, or the tree deadlocks
    # — awaiting parents starve their own children of slots — invisibly to the
    # backlog-based signal.
    workflow_slot_capacity = max(1, max_workflow_slots * max(current_machines, 1))
    workflow_saturation = workflow_count / workflow_slot_capacity
    slot_pressure = workflow_saturation >= WORKFLOW_SATURATION_SCALE_UP
    # Machines to hold running + backlogged workflows at target occupancy,
    # leaving headroom for the children the running parents will spawn.
    slot_target_machines = math.ceil(
        (workflow_count + backlog) / max(1.0, max_workflow_slots * WORKFLOW_SLOT_TARGET_OCCUPANCY)
    )

    if backlog > 0 or slot_pressure:
        _backlog_zero_since = None
        scale_capacity = observed_capacity or DEFAULT_CAPACITY
        additional = backlog / scale_capacity
        # Cooldown: after a scale-up, wait for DNS to propagate
        # before allowing another (prevents overshoot)
        if not in_cooldown and (additional >= SCALE_UP_THRESHOLD or slot_pressure):
            _desired_machines = max(current_machines + math.ceil(additional), slot_target_machines)
        else:
            _desired_machines = current_machines  # Transient blip or in cooldown
    elif admission_pressure and admission_pressure_seconds >= ADMISSION_PRESSURE_SCALE_UP_SECS and not in_cooldown:
        _backlog_zero_since = None
        _desired_machines = current_machines + 1
    elif memory_pressure and workflow_count > 0:
        _backlog_zero_since = None
        _desired_machines = current_machines
    else:
        # Backlog is 0 AND workflow slots are not saturated — safe to probe
        # down. NEVER drain while slots are saturated: pulling a machine out
        # from under awaiting-parent workflows re-creates the fan-out deadlock
        # (this stalled agents mid-run and forced expensive re-spawns).
        if _backlog_zero_since is None:
            _backlog_zero_since = now

        if now - _backlog_zero_since >= SCALE_DOWN_COOLDOWN_SECS:
            # No work at all — go straight to minimum; otherwise probe -1
            _desired_machines = MIN_MACHINES if workflow_count == 0 else current_machines - 1
            _backlog_zero_since = now  # Reset timer for next probe
        else:
            _desired_machines = current_machines  # Hold steady

    _desired_machines = max(MIN_MACHINES, min(MAX_MACHINES, _desired_machines))

    set_queue_observation(
        backlog,
        workflow_count,
        desired_machines=_desired_machines,
        current_machines=current_machines,
        autoscaler_memory_signal_percent=fleet_memory_used_percent,
        autoscaler_memory_threshold_percent=MEMORY_SCALE_UP_THRESHOLD_PERCENT,
    )

    # ── Leader actuates (never an unverified or compute-only worker) ─
    is_leader = role.role == AUTOSCALER_ROLE_LEADER
    if is_leader and AUTOSCALER_ACTUATE and _desired_machines != current_machines:
        if _desired_machines > current_machines:
            _last_scale_up_time = time.monotonic()
        await _scale_fleet(_desired_machines, http, stop_event)

    # ── Smart logging (every 30s or on state change) ──────────
    now_mono = time.monotonic()
    if _desired_machines != _prev_desired or now_mono - _last_log_time >= LOG_INTERVAL_SECS:
        logger.info(
            "Autoscaler poll",
            backlog=backlog,
            workflow_count=workflow_count,
            current_machines=current_machines,
            desired_machines=_desired_machines,
            observed_capacity=observed_capacity,
            scale_capacity_source=scale_capacity_source,
            activity_slots_used=sdk_metrics.get("activity_slots_used"),
            activity_slots_available=sdk_metrics.get("activity_slots_available"),
            resource_slots_cpu_usage=sdk_metrics.get("resource_slots_cpu_usage"),
            resource_slots_mem_usage=sdk_metrics.get("resource_slots_mem_usage"),
            resource_slots_cpu_pid_output=sdk_metrics.get("resource_slots_cpu_pid_output"),
            resource_slots_mem_pid_output=sdk_metrics.get("resource_slots_mem_pid_output"),
            activity_task_pollers=sdk_metrics.get("activity_task_pollers"),
            workflow_task_pollers=sdk_metrics.get("workflow_task_pollers"),
            sticky_workflow_task_pollers=sdk_metrics.get("sticky_workflow_task_pollers"),
            activity_admission_open=activity_admission_open,
            activity_admission_memory_percent=admission_snapshot.get("activity_admission_memory_percent"),
            activity_admission_unavailable_count=activity_admission_unavailable_count,
            activity_admission_scale_threshold=activity_admission_scale_threshold,
            activity_admission_pressure_seconds=round(admission_pressure_seconds, 1),
            memory_used_percent=memory_used_percent,
            fleet_memory_used_percent=fleet_memory_used_percent,
            memory_scale_up_threshold_percent=MEMORY_SCALE_UP_THRESHOLD_PERCENT,
            is_leader=is_leader,
            autoscaler_role=role.role,
            autoscaler_role_reason=role.reason,
        )
        _last_log_time = now_mono
    _prev_desired = _desired_machines


async def monitor_event_loop_lag(
    interval_s: float = 0.25,
    warn_threshold_s: float = 0.25,
) -> None:
    """Measure asyncio event-loop scheduling lag.

    Sleeps ``interval_s`` and measures how much LONGER than that the loop
    actually took to resume this coroutine. The excess is the time the single
    worker event loop was busy (CPU-bound work, blocking calls, or sheer
    coroutine volume) and therefore could not service ready I/O — including the
    LLM stream socket reads. A lag of ~1s here is the direct, no-guess proof of
    the ~1s/chunk stream stalls seen under 50-wide fan-out.

    Emits a sample every ~5s (so we always have a baseline) and a warning the
    instant lag exceeds ``warn_threshold_s``, tagged with process CPU% and the
    live asyncio task count so we can correlate the spike with load.
    """
    loop = asyncio.get_running_loop()
    proc = psutil.Process()
    proc.cpu_percent(None)  # prime the CPU% sampler
    worker_index = int(os.getenv("WORKER_INDEX", "0"))
    max_lag = 0.0
    samples = 0
    since_emit = 0.0
    while True:
        t0 = loop.time()
        await asyncio.sleep(interval_s)
        lag = loop.time() - t0 - interval_s
        max_lag = max(max_lag, lag)
        samples += 1
        since_emit += interval_s + max(lag, 0.0)
        if lag >= warn_threshold_s:
            try:
                task_count = len(asyncio.all_tasks(loop))
            except Exception:
                task_count = -1
            logger.warning(
                event="loop.lag",
                msg="event loop stalled",
                worker_index=worker_index,
                lag_s=round(lag, 3),
                cpu_pct=round(proc.cpu_percent(None), 1),
                num_cpus=psutil.cpu_count(),
                asyncio_tasks=task_count,
            )
        # Heartbeat baseline roughly every 5s regardless of threshold.
        if since_emit >= 5.0:
            logger.info(
                event="loop.lag.baseline",
                msg="loop lag baseline",
                worker_index=worker_index,
                max_lag_s=round(max_lag, 3),
                samples=samples,
                cpu_pct=round(proc.cpu_percent(None), 1),
            )
            max_lag = 0.0
            samples = 0
            since_emit = 0.0


def _start_sdk_runtime(port: int) -> tuple[Runtime, int]:
    """Bind the exporter, retaining its actual address for the worker's scraper.

    The SDK cannot return an ephemeral bind's port or adopt a reserved socket.
    For local secondary workers only, ask the kernel for a free candidate and
    retry a proven bind collision during the socket-to-SDK handoff. Fixed ports
    and unrelated startup failures keep their original fail-fast behavior.
    """
    attempts = 10 if port == 0 else 1
    for attempt in range(attempts):
        selected_port = port
        if port == 0:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
                reservation.bind(("0.0.0.0", 0))
                selected_port = reservation.getsockname()[1]
        try:
            runtime = Runtime(
                telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address=f"0.0.0.0:{selected_port}"))
            )
        except ValueError as error:
            collision = "Failed starting Prometheus exporter" in str(error) and "Address already in use" in str(error)
            if port != 0 or not collision or attempt + 1 == attempts:
                raise
            logger.warning(
                "Worker metrics bind collision; selecting a new port", port=selected_port, attempt=attempt + 1
            )
            continue
        return runtime, selected_port
    raise AssertionError("runtime port allocation exhausted without a result")


NATIVE_CALLBACK_DRAIN_SECONDS = 2.0


def _foreign_threads_running_python() -> bool:
    python_started = {
        thread.ident for thread in threading.enumerate() if not isinstance(thread, threading._DummyThread)
    }
    return any(ident not in python_started for ident in sys._current_frames())


async def _drain_native_python_callbacks(timeout: float = NATIVE_CALLBACK_DRAIN_SECONDS) -> bool:
    """Wait until no SDK-owned native thread is executing Python code.

    An SDK RPC completion resolves its asyncio future from a Tokio thread via
    call_soon_threadsafe, whose self-pipe write releases the GIL before the
    callback returns. If the entry point returns first, that thread re-takes
    the GIL during interpreter finalization and the process aborts (SIGABRT
    "PyGILState_Release ... finalizing" or SIGSEGV) after a clean shutdown.
    """
    deadline = time.monotonic() + timeout
    while _foreign_threads_running_python():
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.005)
    return True


async def main():
    """Main worker entry point."""
    global SDK_METRICS_PORT, HEALTH_CHECK_PORT

    # Trace-archive writes (gzip + AES-GCM + backend POST) must never run inline
    # on the worker event loop — they stall stream reads for every concurrent
    # agent. This opts archive_bytes/archive_json into deferred executor writes.
    os.environ.setdefault("TRACE_ARCHIVE_ASYNC_WRITES", "1")

    # Opt-in cProfile of the worker event loop. The 50-wide fan-out saturates
    # CPU via MANY small callbacks (no single slow callback >0.3s), so only an
    # aggregate profiler reveals where cumulative loop CPU goes. Dumped in the
    # finally block on graceful shutdown -> analyze with pstats.
    _profiler = None
    if os.getenv("PROFILE_WORKER"):
        import cProfile

        _profiler = cProfile.Profile()
        _profiler.enable()
        logger.warning("cProfile enabled for worker", worker_index=os.getenv("WORKER_INDEX", "0"))

    # Load configuration
    config = load_config()
    namespace_refusal = production_namespace_refusal(config.temporal.namespace, config.temporal.task_queue)
    if namespace_refusal:
        logger.error("Temporal namespace isolation refused worker start", reason=namespace_refusal)
        raise SystemExit(namespace_refusal)

    # Log environment mode
    is_production = config.environment == "production"
    print(f"🚀 [Agents] Mode: {'PRODUCTION' if is_production else 'DEVELOPMENT'}")

    # Set up Temporal SDK runtime with Prometheus metrics exporter.
    # Exposes worker_task_slots_used/available from the SDK slot suppliers
    # on a local port. The autoscaler scrapes these to get real capacity.
    runtime, SDK_METRICS_PORT = _start_sdk_runtime(SDK_METRICS_PORT)

    # Start health check server
    _health_thread = run_health_server(config.health_check_port)
    HEALTH_CHECK_PORT = _health_thread.port
    logger.info(
        "Worker observability endpoints bound",
        worker_index=os.getenv("WORKER_INDEX", "0"),
        sdk_metrics_port=SDK_METRICS_PORT,
        health_check_port=HEALTH_CHECK_PORT,
    )

    logger.info(
        "Starting Temporal worker",
        namespace=config.temporal.namespace,
        task_queue=config.temporal.task_queue,
        environment=config.environment,
    )

    # Connect to Temporal Cloud in production or the local dev server for
    # isolated benchmarks that must not depend on outbound port 7233.
    client = await Client.connect(
        config.temporal.address,
        **temporal_connect_options(
            config.temporal.address,
            config.temporal.namespace,
            config.temporal.api_key,
        ),
        runtime=runtime,
    )

    logger.info("Connected to Temporal Cloud")

    build_id = os.getenv("TEMPORAL_WORKER_BUILD_ID")

    # Make client available to query_parent_state_activity
    set_temporal_client(client)

    activity_admission_snapshot = ActivityAdmissionSnapshot(
        maximum_slots=config.temporal.max_concurrent_activities,
        close_memory_percent=config.temporal.activity_admission_close_memory_percent,
        open_memory_percent=config.temporal.activity_admission_open_memory_percent,
        close_cpu_percent=config.temporal.activity_admission_close_cpu_percent,
        open_cpu_percent=config.temporal.activity_admission_open_cpu_percent,
    )

    # All slot suppliers are SDK-native fixed-size. Avoid Python
    # CustomSlotSupplier callbacks: Temporal invokes them from Rust worker
    # threads, and GIL re-entry can deadlock the worker under activity
    # heartbeat traffic.
    #
    # Workflow slots MUST NOT use ResourceBasedSlotSupplier. Workflow tasks are
    # cheap state-machine steps, but pollers must reserve a workflow-task slot
    # BEFORE polling — so when host memory sits above the tuner's target (the
    # steady state on dev Macs at ~83-85% and on prod Fly machines, where the
    # autoscaler deliberately runs memory up to its 75-80% thresholds), the
    # supplier throttles permits to its minimum and the sticky pollers lose
    # the permit race to the nonsticky pollers. The sticky queue then goes
    # unpolled and EVERY workflow task burns the full
    # sticky_queue_schedule_to_start_timeout (10s) before being rescheduled on
    # the normal queue, where a random other worker picks it up with a full
    # history replay. Observed: message-person smoke replay with $0 LLM cost
    # spent ~137s of 153s in ~13 back-to-back 10s sticky timeouts.
    # Memory protection for the actually-heavy work is the activity admission
    # gate above (closes at activity_admission_close_memory_percent /
    # activity_admission_close_cpu_percent) plus the fleet autoscaler — not
    # workflow-task slot starvation.
    tuner = WorkerTuner.create_composite(
        workflow_supplier=FixedSizeSlotSupplier(config.temporal.max_concurrent_workflows),
        activity_supplier=FixedSizeSlotSupplier(config.temporal.max_concurrent_activities),
        local_activity_supplier=FixedSizeSlotSupplier(100),
        nexus_supplier=FixedSizeSlotSupplier(100),
    )

    registered_activities = [
        list_agent_tree_activity,
        fetch_github_repo_inventory_activity,
        resolve_agent_address_activity,
        send_agent_message_activity,
        send_agent_message_to_address_activity,
        kill_agent_activity,
        report_bug_activity,
        spawn_sub_agent_activity,
        spawn_sub_agents_batch_activity,
        fetch_parent_attachments_activity,
        create_approval_request_activity,
        resolve_attention_request_activity,
        agentcard_status_activity,
        create_gate_request_activity,
        has_message_corpus_activity,
        source_status_activity,
        mint_subscription_checkout_activity,
        mint_gmail_connect_activity,
        lookup_purchase_activity,
        mint_purchase_card_activity,
        spawn_browser_agent_activity_v3,
        resolve_code_agent_provider_activity,
        resolve_code_agent_target_activity,
        spawn_claude_code_activity,
        close_detached_code_session_activity,
        web_search_activity,
        people_search_activity,
        web_fetch_activity,
        web_fetch_download_activity,
        resolve_user_tools_activity,
        run_user_tool_activity,
        send_agent_graph_message_activity,
        save_tool_usage,
        read_message_history_activity,
        read_tool_output_activity,
        preview_tool_output_activity,
        generate_message_activity,
        fetch_recent_messages_activity,
        queue_imessage_activity,
        read_phone_message_activity,
        send_agent_sms_activity,
        send_email_activity,
        call_phone_number_activity,
        poll_new_messages,
        post_agent_message,
        call_llm,
        check_progress,
        call_llm_activity,
        call_planner_llm_activity,
        set_response_schema_activity,
        persist_response_schema_activity,
        fetch_claude_max_token_activity,
        fetch_compute_token_activity,
        fetch_gpt_code_token_activity,
        heartbeat_compute_token_lineage_activity,
        mark_claude_token_rate_limited_activity,
        mark_compute_token_rate_limited_activity,
        mark_gpt_token_rate_limited_activity,
        release_compute_token_lineage_activity,
        update_agent_status,
        predict_jev_progress,
        acknowledge_workflow_replacement_bootstrap,
        finalize_workflow_replacement_bootstrap,
        compress_context,
        generate_completion_summary,
        summarize_tool_result,
        summarize_and_filter_links,
        spawn_explore_agent_activity,
        fetch_explore_tool_evidence,
        _resolve_explore_attachments_activity,
        fetch_full_network_metadata,
        evaluate_condition_activity,
        grep_activity,
        api_request_activity,
        fetch_local_data_summary,
        get_model_context_window,
        fetch_agent_tools,
        query_blueprints_activity,
        save_blueprint_activity,
        resolve_attachments_activity,
        mark_finished,
        materialize_oai_demo_report_files_activity,
        fetch_agent_config,
        fetch_code_agent_resume_context,
        fetch_agent_queue_pointer,
        fetch_child_terminal_result_activity,
        fetch_model_pricing,
        check_user_usage,
        get_user_context,
        get_user_system_name,
        get_user_custom_system_prompt,
        update_agent_tree_cost_activity,
        apply_resume_cost_activity,
        update_agent_tree_state,
        resolve_fast_cache_goal_activity,
        resolve_fast_cache_context_activity,
        get_agent_source,
        send_direct_sms_activity,
        notify_sms_event_activity,
        resolve_user_ui_inline_view_activity,
        display_media_activity,
        populate_tool_params_activity,
        execute_reasoning_activity,
        query_parent_state_activity,
        world_model_step_activity,
        world_model_specialized_agent_activity,
        world_clock_activity,
        report_failure_activity,
    ]

    if os.getenv("TEMPORAL_WORKER_REQUIRE_ACTIVATION") == "1":
        if not build_id:
            raise RuntimeError("TEMPORAL_WORKER_BUILD_ID is required when worker activation is enabled")
        deployment_token = os.getenv("TEMPORAL_WORKER_DEPLOYMENT_TOKEN")
        if not deployment_token:
            raise RuntimeError("TEMPORAL_WORKER_DEPLOYMENT_TOKEN is required when worker activation is enabled")
        validation_task_queue = os.getenv("TEMPORAL_WORKER_VALIDATION_TASK_QUEUE")
        if not validation_task_queue:
            raise RuntimeError("TEMPORAL_WORKER_VALIDATION_TASK_QUEUE is required when worker activation is enabled")
        validation_worker = Worker(
            client,
            task_queue=validation_task_queue,
            workflows=[AgentWorkflow, *COMPANION_WORKFLOWS],
            activities=registered_activities,
            workflow_runner=production_workflow_runner(),
            interceptors=production_worker_interceptors(),
        )
        set_worker_status(True, phase="standby", build_id=build_id)
        logger.info(
            "Candidate worker ready on isolated validation queue; production polling is activation-gated",
            worker_build_id=build_id,
            task_queue=config.temporal.task_queue,
            validation_task_queue=validation_task_queue,
        )
        async with validation_worker:
            marker_id = await wait_for_worker_build_activation(
                client,
                build_id,
                deployment_token,
                timeout_seconds=float(os.getenv("TEMPORAL_WORKER_ACTIVATION_TIMEOUT_SECONDS", "7200")),
                poll_interval_seconds=float(os.getenv("TEMPORAL_WORKER_ACTIVATION_POLL_SECONDS", "1")),
            )
        logger.info(
            "Worker build activated; constructing production Temporal pollers",
            worker_build_id=build_id,
            activation_marker_workflow_id=marker_id,
        )

    # Zero-downtime cutover: poll this build's generation-scoped queue
    # (`<base>@<surfaceHash>`) so a worker never replays a foreign generation's
    # history. Absent a surface hash, poll the plain base queue (pre-cutover
    # behavior). The metrics poller reports on the SAME queue so the
    # fly-autoscaler scales each generation's fleet by its own backlog and old
    # generations retire as they drain.
    production_task_queue = resolve_production_task_queue(
        config.temporal.task_queue,
        os.getenv("TEMPORAL_WORKER_SURFACE_HASH"),
    )
    logger.info(
        "Resolved production task queue for this worker generation",
        base_task_queue=config.temporal.task_queue,
        surface_hash=os.getenv("TEMPORAL_WORKER_SURFACE_HASH") or None,
        production_task_queue=production_task_queue,
    )
    # The backend starts newer workflow types (code/browser resume runs) only on a
    # queue whose workers recorded them: background, best-effort, idempotent.
    # Held in this frame for the worker's lifetime (never garbage-collected mid-flight).
    _capabilities_task = asyncio.create_task(
        record_worker_queue_capabilities(production_task_queue, [AgentWorkflow, *COMPANION_WORKFLOWS])
    )

    # Warm the planner-RAG index (one encrypted object from the archive
    # backend) so the first set_plan on this worker does not pay the cold
    # load. Best-effort: retrieval degrades to "no reference plans".

    # Create worker with all workflows and activities
    shutdown_grace_seconds = parse_shutdown_grace_seconds(
        os.getenv("WORKER_SHUTDOWN_GRACE_PERIOD"),
        default=2100,
    )
    worker = Worker(
        client,
        task_queue=production_task_queue,
        workflows=[AgentWorkflow, *COMPANION_WORKFLOWS],
        activities=registered_activities,
        tuner=tuner,
        max_cached_workflows=config.temporal.max_cached_workflows,
        sticky_queue_schedule_to_start_timeout=timedelta(
            seconds=config.temporal.sticky_queue_schedule_to_start_timeout_seconds
        ),
        max_concurrent_activity_task_polls=config.temporal.max_concurrent_activity_task_polls,
        max_concurrent_workflow_task_polls=config.temporal.max_concurrent_workflow_task_polls,
        # Cancellation reaches long-running activities in heartbeat responses.
        # Do not batch the browser's 15s keepalive behind the SDK's 60s default.
        max_heartbeat_throttle_interval=timedelta(seconds=HEARTBEAT_KEEPALIVE_SECONDS),
        nonsticky_to_sticky_poll_ratio=config.temporal.nonsticky_to_sticky_poll_ratio,
        workflow_runner=production_workflow_runner(),
        # Stop polling on shutdown; let in-flight activities (incl. 30m browser) finish.
        graceful_shutdown_timeout=timedelta(seconds=shutdown_grace_seconds),
        # Bind each activity to its workflow's agent/root for archive records,
        # and attribute a timed-out attempt whose body never ran to the worker.
        interceptors=production_worker_interceptors(),
    )

    logger.info(
        "Worker configured with memory-gated activity slots",
        activity_admission_close_memory_percent=config.temporal.activity_admission_close_memory_percent,
        activity_admission_open_memory_percent=config.temporal.activity_admission_open_memory_percent,
        max_activity_slots=config.temporal.max_concurrent_activities,
        max_workflow_slots=config.temporal.max_concurrent_workflows,
        nonsticky_to_sticky_poll_ratio=config.temporal.nonsticky_to_sticky_poll_ratio,
        sticky_queue_schedule_to_start_timeout_seconds=(config.temporal.sticky_queue_schedule_to_start_timeout_seconds),
    )

    # Handle shutdown gracefully using asyncio signal handlers
    loop = asyncio.get_running_loop()

    # Opt-in asyncio debug: logs any single callback/coroutine step that blocks
    # the event loop longer than slow_callback_duration, naming the exact handle.
    # This is the in-process replacement for py-spy when diagnosing which work
    # hogs the single worker loop under high concurrency.
    if os.getenv("ASYNCIO_DEBUG_SLOW_CALLBACKS"):
        loop.set_debug(True)
        loop.slow_callback_duration = float(os.getenv("ASYNCIO_SLOW_CALLBACK_S", "0.3"))
        logging.getLogger("asyncio").setLevel(logging.WARNING)
        logger.warning(
            "asyncio debug enabled",
            slow_callback_duration_s=loop.slow_callback_duration,
        )

    shutdown_event = asyncio.Event()
    force_kill_event = asyncio.Event()
    shutdown_count = 0

    def handle_shutdown():
        nonlocal shutdown_count
        shutdown_count += 1

        if shutdown_count == 1:
            logger.info("🛑 Shutdown signal received (Ctrl+C again to force kill)...")
            shutdown_event.set()
        else:
            logger.warning("⚡ Force kill requested, exiting immediately!")
            force_kill_event.set()
            # Schedule force exit after a brief moment to let logs flush
            loop.call_later(0.5, lambda: os._exit(1))

    # Register signal handlers with the event loop (asyncio-compatible)
    loop.add_signal_handler(signal.SIGINT, handle_shutdown)
    loop.add_signal_handler(signal.SIGTERM, handle_shutdown)

    # Own these tasks through worker drain. Cancelling a Python Temporal RPC
    # future does not join its native completion callback; leaving that callback
    # to interpreter finalization can deadlock the SDK runtime's thread pool.
    metrics_stop = asyncio.Event()
    metrics_task = asyncio.create_task(
        poll_queue_metrics(
            client,
            config.temporal.namespace,
            production_task_queue,
            activity_admission_snapshot,
            config.temporal.max_concurrent_workflows,
            metrics_stop,
        ),
    )
    lag_task = asyncio.create_task(monitor_event_loop_lag())

    try:
        # Run worker and shutdown event concurrently
        worker_task = asyncio.create_task(worker.run())
        # Temporal's Worker object does not become operational until run() has
        # completed its namespace validation and started its internal poller
        # tasks. Publishing healthy (or a readiness log) before this boundary
        # let autoscaled clones count as capacity even when run() failed on its
        # first event-loop turn.
        while not worker.is_running:
            await asyncio.sleep(0.05)
            if worker_task.done():
                await worker_task
                raise RuntimeError("Temporal worker stopped before reaching readiness")
        set_worker_status(True, phase="running", build_id=build_id)
        # Preserve the long-standing readiness string consumed by local E2E and
        # operator workflows, but emit it only after the real readiness boundary.
        logger.info("Worker started, waiting for tasks...")
        logger.info("Worker ready, polling Temporal task queue")

        shutdown_task = asyncio.create_task(shutdown_event.wait())

        # Wait for either worker to stop or shutdown signal
        done, pending = await asyncio.wait([worker_task, shutdown_task], return_when=asyncio.FIRST_COMPLETED)

        # If shutdown was signaled, shutdown worker cleanly with timeout
        if shutdown_task in done:
            logger.info(f"Stopping worker task ({shutdown_grace_seconds}s grace, Ctrl+C again to force)...")

            # Create a force kill watcher
            async def force_kill_watcher():
                await force_kill_event.wait()
                raise SystemExit(1)

            force_task = asyncio.create_task(force_kill_watcher())

            try:
                # Try graceful shutdown with 5 second timeout
                await asyncio.wait_for(worker.shutdown(), timeout=shutdown_grace_seconds)
                logger.info("Worker shutdown complete, cancelling worker task...")
            except asyncio.TimeoutError:
                logger.warning(f"⚠️ Graceful shutdown timed out after {shutdown_grace_seconds}s, forcing exit...")
                # os._exit() bypasses the finally block below, so drain detached
                # browser cleanups here too (bounded) before we hard-exit, or
                # Steel/Playwright sessions get orphaned on the timeout path.
                with contextlib.suppress(Exception):
                    await drain_background_browser_cleanups(timeout=10.0)
                os._exit(1)
            finally:
                force_task.cancel()

            # Cancel the worker task and wait for it
            worker_task.cancel()
            try:
                await asyncio.wait_for(worker_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                logger.info("Worker task cancelled")

    except asyncio.CancelledError:
        logger.info("Worker cancelled, shutting down...")
        try:
            await asyncio.wait_for(worker.shutdown(), timeout=min(30, shutdown_grace_seconds))
        except asyncio.TimeoutError:
            logger.warning("Shutdown timed out, forcing exit...")
    except SystemExit:
        logger.info("Force exit requested")
    except Exception as e:
        logger.error(f"Worker error: {str(e)}", exc_info=True)
        set_worker_status(False)
        raise
    finally:
        primary_error = sys.exception()
        metrics_error = None
        set_worker_status(False)
        # Drain detached browser cleanups so Steel/Playwright sessions and driver
        # PIDs aren't orphaned when the worker exits mid-teardown. Uses the drain
        # helper's default timeout, sized to the worst-case single-cleanup latency;
        # it returns as soon as all tasks finish (typically fast).
        with contextlib.suppress(Exception):
            await drain_background_browser_cleanups()
        # Keep metrics available while activities drain, then prevent new polls
        # and let the current bounded SDK call complete without cancellation.
        metrics_stop.set()
        try:
            await metrics_task
        except Exception as error:
            metrics_error = error
            logger.warning("Metrics poller failed during shutdown", error=str(error))
        finally:
            lag_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await lag_task
        if _profiler is not None:
            _profiler.disable()
            out = f"worker-profile-{os.getenv('WORKER_INDEX', '0')}.prof"
            _profiler.dump_stats(out)
            logger.warning("cProfile stats dumped", path=out)
        if not await _drain_native_python_callbacks():
            logger.warning("Native SDK callback still executing Python at worker exit")
        logger.info("Worker stopped")
        if metrics_error is not None and primary_error is None:
            raise metrics_error


if __name__ == "__main__":
    run_then_exit(main, run=run_worker_event_loop)
