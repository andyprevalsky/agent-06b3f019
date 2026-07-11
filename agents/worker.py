"""Temporal worker for Rose autonomous agents."""

import asyncio
import contextlib
import logging
import os
import re
import signal
import sys
from datetime import timedelta

import psutil
import structlog
from dotenv import load_dotenv
from temporalio.client import Client, TLSConfig
from temporalio.runtime import PrometheusConfig, Runtime, TelemetryConfig
from temporalio.worker import (
    FixedSizeSlotSupplier,
    Worker,
    WorkerTuner,
)
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

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
from config import load_config
from domains.call_phone_number.handler import call_phone_number_activity
from domains.grep.repo import fetch_local_data_summary, grep_activity
from domains.knowledge_base.handler import query_blueprints_activity, save_blueprint_activity
from domains.message_person.repo import fetch_recent_messages_activity, generate_message_activity
from domains.read_message_history.handler import read_message_history_activity
from domains.reasoning.handler import execute_reasoning_activity
from domains.request_payment_card.repo import lookup_purchase_activity, mint_purchase_card_activity
from domains.request_user_approval.repo import create_approval_request_activity
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    fetch_full_network_metadata,
    spawn_explore_agent_activity,
)
from domains.spawn_browser_agent_v3.handler import (
    drain_background_browser_cleanups,
    spawn_browser_agent_activity_v3,
)
from domains.spawn_claude_code_agent.service import spawn_claude_code_activity
from domains.spawn_sub_agents.service import (
    spawn_sub_agent_activity,
    spawn_sub_agents_batch_activity,
)
from domains.wait_for.service import evaluate_condition_activity
from domains.web_fetch.handler import web_fetch_activity, web_fetch_download_activity
from health_server import run_health_server, set_queue_metrics, set_worker_status

# Helper activities (workflow orchestration, not exposed to LLM)
from helpers import (
    call_llm,
    call_llm_activity,
    check_progress,
    check_user_usage,
    compress_context,
    fetch_agent_config,
    fetch_agent_tools,
    fetch_child_terminal_result_activity,
    fetch_model_pricing,
    generate_completion_summary,
    get_model_context_window,
    get_user_context,
    get_user_custom_system_prompt,
    get_user_system_name,
    mark_finished,
    poll_new_messages,
    post_agent_message,
    resolve_fast_cache_goal_activity,
    summarize_tool_result,
    update_agent_status,
)
from helpers.attachments import fetch_parent_attachments_activity, resolve_attachments_activity
from helpers.llm import (
    call_planner_llm_activity,
    fetch_claude_max_token_activity,
    fetch_compute_token_activity,
    fetch_gpt_code_token_activity,
    heartbeat_compute_token_lineage_activity,
    mark_claude_token_rate_limited_activity,
    mark_compute_token_rate_limited_activity,
    mark_gpt_token_rate_limited_activity,
    set_response_schema_activity,
)
from helpers.messages import update_agent_tree_state
from helpers.query_parent_state import query_parent_state_activity, set_temporal_client
from helpers.save_tool_usage import save_tool_usage
from helpers.sms_activities import (
    get_agent_source,
    notify_sms_event_activity,
    send_direct_sms_activity,
)
from helpers.summarize import summarize_and_filter_links
from helpers.update_tokens import update_agent_tokens_activity, update_agent_tree_cost_activity
from helpers.world_model_runtime import world_model_step_activity
from tools.people_search import people_search_activity  # not yet refactored into domains/
from tools.web_search import web_search_activity  # not yet refactored into domains/
from workflows import AgentWorkflow

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


import math
import socket
import time

import httpx

# ── Adaptive autoscaler ──────────────────────────────────────────────────
# Built-in controller: no separate autoscaler machine needed.
# Every worker polls Temporal (1s), computes desired fleet size.
# Only the leader (lowest-IP via Fly DNS) actuates via Fly Machines API.
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
POLL_INTERVAL_SECS = 1  # 3 Temporal API calls/s — well within 1000 req/s limit
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


def _get_peer_ips(app_name: str) -> list[str]:
    """Get sorted list of all peer IPv6 addresses via Fly internal DNS."""
    try:
        addrs = socket.getaddrinfo(f"{app_name}.internal", None, socket.AF_INET6)
        return sorted(set(a[4][0] for a in addrs))
    except socket.gaierror:
        return []


def _count_fly_peers() -> int:
    """Count running Fly machines via internal AAAA DNS."""
    fly_app = os.getenv("FLY_APP_NAME")
    if not fly_app:
        return 1  # Local development
    return max(len(_get_peer_ips(fly_app)), 1)


def _am_i_leader() -> bool:
    """Leader election via DNS: lowest IPv6 address is the leader.

    All workers compute desired_machine_count, but only the leader
    actuates by calling the Fly Machines API to start/stop machines.
    If the leader dies, it disappears from DNS and the next-lowest
    IP takes over automatically within 1 poll cycle.
    """
    fly_app = os.getenv("FLY_APP_NAME")
    if not fly_app:
        return True  # Local dev — only worker
    my_ip = os.getenv("FLY_PRIVATE_IP")
    if not my_ip:
        return True
    peers = _get_peer_ips(fly_app)
    if not peers:
        return True
    return my_ip == peers[0]


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


async def _get_fleet_memory_used_percent(http: httpx.AsyncClient, local_memory_used_percent: float) -> float:
    """Return max machine memory percent across the Fly worker fleet.

    Only the elected leader can start machines, so the leader must consider
    memory pressure on non-leader peers too. If peer scraping fails, fall back
    to the local sample so autoscaling still works in local/dev environments.
    """
    fly_app = os.getenv("FLY_APP_NAME")
    if not fly_app:
        return local_memory_used_percent

    peers = _get_peer_ips(fly_app)
    if not peers:
        return local_memory_used_percent

    memory_samples = [local_memory_used_percent]
    for ip in peers:
        try:
            resp = await http.get(f"http://[{ip}]:{HEALTH_CHECK_PORT}/metrics", timeout=1.0)
            if resp.status_code != 200:
                continue
            value = _extract_metric_value(resp.text, "machine_memory_used_percent")
            if value is not None:
                memory_samples.append(value)
        except Exception as e:
            logger.debug("Failed to scrape peer memory metric", peer_ip=ip, error=str(e))

    return max(memory_samples)


async def _get_fleet_activity_admission_unavailable_count(
    http: httpx.AsyncClient,
    *,
    local_activity_admission_open: bool,
    current_machines: int,
) -> int:
    """Return count of workers currently closed to new activity work."""
    fly_app = os.getenv("FLY_APP_NAME")
    if not fly_app:
        return 0 if local_activity_admission_open else 1

    peers = _get_peer_ips(fly_app)
    if not peers:
        return 0 if local_activity_admission_open else 1

    unavailable = 0
    samples = 0
    for ip in peers:
        try:
            resp = await http.get(f"http://[{ip}]:{HEALTH_CHECK_PORT}/metrics", timeout=1.0)
            if resp.status_code != 200:
                continue
            value = _extract_metric_value(resp.text, "activity_admission_open")
            if value is None:
                continue
            samples += 1
            if value < 0.5:
                unavailable += 1
        except Exception as e:
            logger.debug("Failed to scrape peer activity admission metric", peer_ip=ip, error=str(e))

    if samples == 0:
        return 0 if local_activity_admission_open else 1
    return min(unavailable, current_machines)


def _activity_admission_scale_threshold(current_machines: int) -> int:
    if current_machines <= 3:
        return 1
    return max(2, math.ceil(current_machines * 0.20))


async def _scale_fleet(desired: int, http: httpx.AsyncClient):
    """Start/stop Fly machines to reach desired count. Called by leader only.

    Machines must be pre-provisioned up to MAX_MACHINES (e.g. `fly scale count 10`).
    This function starts/stops existing machines — it does not create or destroy them.
    """
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
        resp.raise_for_status()
        machines = resp.json()

        started = [m for m in machines if m["state"] == "started"]
        stopped = [m for m in machines if m["state"] == "stopped"]
        current = len(started)

        if desired > current and stopped:
            to_start = min(desired - current, len(stopped))
            for m in stopped[:to_start]:
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
            for m in candidates[:to_stop]:
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


async def poll_queue_metrics(
    client: Client,
    namespace: str,
    task_queue: str,
    activity_admission_snapshot: ActivityAdmissionSnapshot,
    max_workflow_slots: int,
):
    """Adaptive autoscaler: poll Temporal, compute desired machines, actuate via Fly API.

    Runs on every worker at 1s intervals. All workers observe and compute
    desired_machine_count (exposed via /metrics for monitoring). Only the leader
    (lowest-IP machine via Fly internal DNS) actuates by calling the Fly Machines
    API to start/stop machines.

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
      Memory pressure blocks scale-down.

    No separate autoscaler machine needed — the navi-whisper-lux-autoscaler app
    can be decommissioned.
    """
    global \
        _admission_pressure_since, \
        _backlog_zero_since, \
        _desired_machines, \
        _last_log_time, \
        _last_scale_up_time, \
        _prev_desired

    from temporalio.api.enums.v1 import TaskQueueType
    from temporalio.api.taskqueue.v1 import TaskQueue as TaskQueueProto
    from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest

    async with httpx.AsyncClient(timeout=10.0) as http:
        while True:
            try:
                # ── Observe current state ─────────────────────────────────
                count_result = await client.count_workflows(
                    f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"'
                )
                workflow_count = count_result.count

                backlog = 0
                for task_type in [TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY, TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW]:
                    try:
                        resp = await client.workflow_service.describe_task_queue(
                            DescribeTaskQueueRequest(
                                namespace=namespace,
                                task_queue=TaskQueueProto(name=task_queue),
                                task_queue_type=task_type,
                            )
                        )
                        if resp.task_queue_status:
                            backlog += resp.task_queue_status.backlog_count_hint
                    except Exception as e:
                        logger.warning("Failed to describe task queue", error=str(e), task_queue_type=str(task_type))

                # Get raw capacity/tuner signals from the SDK. Some SDK builds
                # expose slots_used but not slots_available; keep missing values
                # as None so diagnostics do not confuse unknown with zero.
                sdk_metrics = await _get_sdk_worker_metrics(http)
                if sdk_metrics is None:
                    sdk_metrics = {}
                activity_slots_used = sdk_metrics.get("activity_slots_used")
                activity_slots_available = sdk_metrics.get("activity_slots_available")
                if activity_slots_available is not None:
                    observed_capacity = max(int(activity_slots_used or 0) + int(activity_slots_available), 1)
                    scale_capacity_source = "sdk_slots"
                else:
                    observed_capacity = None
                    scale_capacity_source = "fallback_missing_sdk_available_slots"

                memory_used_percent = _get_machine_memory_used_percent()
                fleet_memory_used_percent = await _get_fleet_memory_used_percent(http, memory_used_percent)
                memory_pressure = fleet_memory_used_percent >= MEMORY_SCALE_UP_THRESHOLD_PERCENT
                current_machines = _count_fly_peers()
                is_leader = _am_i_leader()
                admission_snapshot = activity_admission_snapshot.snapshot()
                activity_admission_open = bool(admission_snapshot["activity_admission_open"])
                activity_admission_unavailable_count = await _get_fleet_activity_admission_unavailable_count(
                    http,
                    local_activity_admission_open=activity_admission_open,
                    current_machines=current_machines,
                )
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
                admission_pressure_seconds = (
                    0.0 if _admission_pressure_since is None else now - _admission_pressure_since
                )
                # Workflow-slot occupancy: a for_each parent holds a workflow slot
                # while awaiting its children, so a deep/wide fan-out can pin every
                # workflow slot with ZERO Temporal backlog hint (the children can't be
                # scheduled to even enter the backlog). Scale on observed occupancy too,
                # or the tree deadlocks — awaiting parents starve their own children of
                # slots — invisibly to the backlog-based signal.
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
                elif (
                    admission_pressure
                    and admission_pressure_seconds >= ADMISSION_PRESSURE_SCALE_UP_SECS
                    and not in_cooldown
                ):
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

                set_queue_metrics(
                    backlog,
                    workflow_count,
                    _desired_machines,
                    current_machines,
                    is_leader,
                    observed_capacity,
                    activity_slots_used,
                    activity_slots_available,
                    memory_used_percent,
                    MEMORY_SCALE_UP_THRESHOLD_PERCENT,
                    fleet_memory_used_percent,
                    resource_slots_cpu_usage=sdk_metrics.get("resource_slots_cpu_usage"),
                    resource_slots_mem_usage=sdk_metrics.get("resource_slots_mem_usage"),
                    resource_slots_cpu_pid_output=sdk_metrics.get("resource_slots_cpu_pid_output"),
                    resource_slots_mem_pid_output=sdk_metrics.get("resource_slots_mem_pid_output"),
                    activity_task_pollers=sdk_metrics.get("activity_task_pollers"),
                    workflow_task_pollers=sdk_metrics.get("workflow_task_pollers"),
                    sticky_workflow_task_pollers=sdk_metrics.get("sticky_workflow_task_pollers"),
                    activity_admission_open=activity_admission_open,
                    activity_admission_memory_percent=float(admission_snapshot["activity_admission_memory_percent"]),
                    activity_admission_close_memory_percent=float(
                        admission_snapshot["activity_admission_close_memory_percent"]
                    ),
                    activity_admission_open_memory_percent=float(
                        admission_snapshot["activity_admission_open_memory_percent"]
                    ),
                )

                # ── Leader actuates (unless compute-only, e.g. per-bench cloud) ─
                if is_leader and AUTOSCALER_ACTUATE and _desired_machines != current_machines:
                    if _desired_machines > current_machines:
                        _last_scale_up_time = time.monotonic()
                    await _scale_fleet(_desired_machines, http)

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
                        activity_slots_used=activity_slots_used,
                        activity_slots_available=activity_slots_available,
                        resource_slots_cpu_usage=sdk_metrics.get("resource_slots_cpu_usage"),
                        resource_slots_mem_usage=sdk_metrics.get("resource_slots_mem_usage"),
                        resource_slots_cpu_pid_output=sdk_metrics.get("resource_slots_cpu_pid_output"),
                        resource_slots_mem_pid_output=sdk_metrics.get("resource_slots_mem_pid_output"),
                        activity_task_pollers=sdk_metrics.get("activity_task_pollers"),
                        workflow_task_pollers=sdk_metrics.get("workflow_task_pollers"),
                        sticky_workflow_task_pollers=sdk_metrics.get("sticky_workflow_task_pollers"),
                        activity_admission_open=activity_admission_open,
                        activity_admission_memory_percent=admission_snapshot["activity_admission_memory_percent"],
                        activity_admission_unavailable_count=activity_admission_unavailable_count,
                        activity_admission_scale_threshold=activity_admission_scale_threshold,
                        activity_admission_pressure_seconds=round(admission_pressure_seconds, 1),
                        memory_used_percent=memory_used_percent,
                        fleet_memory_used_percent=fleet_memory_used_percent,
                        memory_scale_up_threshold_percent=MEMORY_SCALE_UP_THRESHOLD_PERCENT,
                        is_leader=is_leader,
                    )
                    _last_log_time = now_mono
                _prev_desired = _desired_machines

            except Exception as e:
                logger.warning("Failed to poll queue metrics", error=str(e))

            await asyncio.sleep(POLL_INTERVAL_SECS)


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


async def main():
    """Main worker entry point."""

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

    # Log environment mode
    is_production = config.environment == "production"
    print(f"🚀 [Agents] Mode: {'PRODUCTION' if is_production else 'DEVELOPMENT'}")

    # Set up Temporal SDK runtime with Prometheus metrics exporter.
    # Exposes worker_task_slots_used/available from the SDK slot suppliers
    # on a local port. The autoscaler scrapes these to get real capacity.
    runtime = Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address=f"0.0.0.0:{SDK_METRICS_PORT}")))

    # Start health check server
    _health_thread = run_health_server(config.health_check_port)
    set_worker_status(True)

    logger.info(
        "Starting Temporal worker",
        namespace=config.temporal.namespace,
        task_queue=config.temporal.task_queue,
        environment=config.environment,
    )

    # Connect to Temporal Cloud
    client = await Client.connect(
        config.temporal.address,
        namespace=config.temporal.namespace,
        tls=TLSConfig(
            client_cert=None,
            client_private_key=None,
        ),
        rpc_metadata={
            "temporal-namespace": config.temporal.namespace,
            "Authorization": f"Bearer {config.temporal.api_key}",
        },
        runtime=runtime,
    )

    logger.info("Connected to Temporal Cloud")

    # Make client available to query_parent_state_activity
    set_temporal_client(client)

    # Configure workflow sandbox to passthrough logging libraries
    # These libraries use threading.local which isn't allowed in the sandbox,
    # but they're only used in activities, not workflows
    sandbox_restrictions = SandboxRestrictions.default.with_passthrough_modules(
        "rich",
        "rich.console",
        "structlog.dev",
        "markdown_it_py",
        "pygments",
        "httpx",
        "sniffio",
        # helpers.llm uses threading.Lock via OpenAI/instructor clients
        # but workflow only calls activities via execute_activity, not directly
        "helpers.llm",
        # helpers.attachments downloads files from storage using httpx
        # called from build_llm_messages when resolving file attachments
        "helpers.attachments",
    )

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

    # Start background queue metrics poller (feeds /metrics for fly-autoscaler)
    asyncio.create_task(
        poll_queue_metrics(
            client,
            config.temporal.namespace,
            config.temporal.task_queue,
            activity_admission_snapshot,
            config.temporal.max_concurrent_workflows,
        ),
    )

    # Start event-loop lag monitor (direct measurement of scheduling starvation
    # under high concurrency — see monitor_event_loop_lag docstring).
    asyncio.create_task(monitor_event_loop_lag())

    # Create worker with all workflows and activities
    worker = Worker(
        client,
        task_queue=config.temporal.task_queue,
        workflows=[AgentWorkflow],
        activities=[
            spawn_sub_agent_activity,
            spawn_sub_agents_batch_activity,
            fetch_parent_attachments_activity,
            create_approval_request_activity,
            lookup_purchase_activity,
            mint_purchase_card_activity,
            spawn_browser_agent_activity_v3,  # V3: browser-use + Rose API
            spawn_claude_code_activity,  # Claude Code in E2B sandbox
            # New event-driven tool activities
            web_search_activity,
            people_search_activity,
            web_fetch_activity,
            web_fetch_download_activity,
            save_tool_usage,
            read_message_history_activity,
            generate_message_activity,
            fetch_recent_messages_activity,
            # Phone call activity
            call_phone_number_activity,
            # Helper activities
            poll_new_messages,
            post_agent_message,
            call_llm,
            check_progress,
            call_llm_activity,
            call_planner_llm_activity,
            set_response_schema_activity,
            fetch_claude_max_token_activity,
            fetch_compute_token_activity,
            fetch_gpt_code_token_activity,
            heartbeat_compute_token_lineage_activity,
            mark_claude_token_rate_limited_activity,
            mark_compute_token_rate_limited_activity,
            mark_gpt_token_rate_limited_activity,
            update_agent_status,
            compress_context,
            generate_completion_summary,
            summarize_tool_result,
            summarize_and_filter_links,
            spawn_explore_agent_activity,
            _resolve_explore_attachments_activity,
            fetch_full_network_metadata,
            evaluate_condition_activity,
            grep_activity,
            fetch_local_data_summary,
            get_model_context_window,
            fetch_agent_tools,
            query_blueprints_activity,
            save_blueprint_activity,
            resolve_attachments_activity,
            mark_finished,
            fetch_agent_config,
            fetch_child_terminal_result_activity,
            fetch_model_pricing,
            check_user_usage,
            get_user_context,
            get_user_system_name,
            get_user_custom_system_prompt,
            update_agent_tokens_activity,
            update_agent_tree_cost_activity,
            update_agent_tree_state,
            # Fast Mode cache goal resolution (persisted Agent-row goal)
            resolve_fast_cache_goal_activity,
            # SMS activities
            get_agent_source,
            send_direct_sms_activity,
            notify_sms_event_activity,
            # DAG executor activities
            populate_tool_params_activity,
            execute_reasoning_activity,
            # Parent state query (for sub-agent → parent communication)
            query_parent_state_activity,
            # World-model runtime shim
            world_model_step_activity,
        ],
        tuner=tuner,
        max_cached_workflows=config.temporal.max_cached_workflows,
        sticky_queue_schedule_to_start_timeout=timedelta(
            seconds=config.temporal.sticky_queue_schedule_to_start_timeout_seconds
        ),
        max_concurrent_activity_task_polls=config.temporal.max_concurrent_activity_task_polls,
        max_concurrent_workflow_task_polls=config.temporal.max_concurrent_workflow_task_polls,
        nonsticky_to_sticky_poll_ratio=config.temporal.nonsticky_to_sticky_poll_ratio,
        workflow_runner=SandboxedWorkflowRunner(restrictions=sandbox_restrictions),
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

    # Run worker
    logger.info("Worker started, waiting for tasks...")

    try:
        # Run worker and shutdown event concurrently
        worker_task = asyncio.create_task(worker.run())
        shutdown_task = asyncio.create_task(shutdown_event.wait())

        # Wait for either worker to stop or shutdown signal
        done, pending = await asyncio.wait([worker_task, shutdown_task], return_when=asyncio.FIRST_COMPLETED)

        # If shutdown was signaled, shutdown worker cleanly with timeout
        if shutdown_task in done:
            logger.info("Stopping worker task (5s timeout, Ctrl+C again to force)...")

            # Create a force kill watcher
            async def force_kill_watcher():
                await force_kill_event.wait()
                raise SystemExit(1)

            force_task = asyncio.create_task(force_kill_watcher())

            try:
                # Try graceful shutdown with 5 second timeout
                await asyncio.wait_for(worker.shutdown(), timeout=5.0)
                logger.info("Worker shutdown complete, cancelling worker task...")
            except asyncio.TimeoutError:
                logger.warning("⚠️ Graceful shutdown timed out after 5s, forcing exit...")
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
            await asyncio.wait_for(worker.shutdown(), timeout=3.0)
        except asyncio.TimeoutError:
            logger.warning("Shutdown timed out, forcing exit...")
    except SystemExit:
        logger.info("Force exit requested")
    except Exception as e:
        logger.error(f"Worker error: {str(e)}", exc_info=True)
        set_worker_status(False)
        raise
    finally:
        set_worker_status(False)
        # Drain detached browser cleanups so Steel/Playwright sessions and driver
        # PIDs aren't orphaned when the worker exits mid-teardown. Uses the drain
        # helper's default timeout, sized to the worst-case single-cleanup latency;
        # it returns as soon as all tasks finish (typically fast).
        with contextlib.suppress(Exception):
            await drain_background_browser_cleanups()
        if _profiler is not None:
            _profiler.disable()
            out = f"worker-profile-{os.getenv('WORKER_INDEX', '0')}.prof"
            _profiler.dump_stats(out)
            logger.warning("cProfile stats dumped", path=out)
        logger.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
