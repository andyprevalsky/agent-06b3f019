"""Temporal worker for Rose autonomous agents."""

import asyncio
import signal
import sys
import os
import logging
from dotenv import load_dotenv
from temporalio.client import Client, TLSConfig
from temporalio.runtime import Runtime, TelemetryConfig, PrometheusConfig
from temporalio.worker import Worker, WorkerTuner, ResourceBasedSlotConfig
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions
import structlog

# Load .env file before anything else
load_dotenv()

# Verify critical env vars
if not os.getenv("BACKEND_API_KEY"):
    print("❌ ERROR: BACKEND_API_KEY not found in environment")
    print("Please add BACKEND_API_KEY to your .env file")
    sys.exit(1)

from config import load_config
from workflows import AgentWorkflow
# User-configurable tools
from tools.spawn_sub_agents import spawn_sub_agent_activity
from tools.request_user_approval import create_approval_request_activity
from tools.send_sms import send_sms_activity
from tools.send_sms_as_user import queue_imessage_activity
from tools.send_email import send_email_activity
from tools.spawn_browser_agent_v3 import spawn_browser_agent_activity_v3  # V3: browser-use + Rose API
from tools.spawn_claude_code_agent import spawn_claude_code_activity  # Claude Code in E2B sandbox
# New event-driven tools
from tools.deep_research import deep_research_activity
from tools.knowledge_base import query_blueprints_activity, save_blueprint_activity
from tools.web_search import web_search_activity
from tools.web_fetch import web_fetch_activity
from tools.people_search import people_search_activity
from tools.find_all import (
    find_all_ingest_activity,
    find_all_create_run_activity,
    find_all_poll_status_once_activity,
    find_all_get_results_activity,
)
from tools.enrich import (
    enrich_create_task_activity,
    enrich_poll_status_once_activity,
    enrich_get_task_results_activity,
)
from tools.monitor import monitor_activity
from tools.check_monitor_events import check_monitor_events_activity
from tools.search_user_network import search_user_network_activity
from tools.read_message_history import read_message_history_activity
from tools.message_person import generate_message_activity, fetch_recent_messages_activity
from tools.x402_bazaar import search_x402_bazaar_activity, pay_for_x402_service_activity
from tools.call_phone_number import call_phone_number_activity
# Helper activities (workflow orchestration, not exposed to LLM)
from helpers import (
    poll_new_messages,
    post_agent_message,
    call_llm,
    check_progress,
    call_llm_activity,
    update_agent_status,
    compress_context,
    generate_completion_summary,
    get_model_context_window,
    fetch_agent_tools,
    mark_finished,
    fetch_agent_config,
    check_user_usage,
    get_user_context,
    get_user_system_name,
    get_user_custom_system_prompt,
    fetch_model_pricing,
)
from helpers.llm import call_planner_llm_activity, set_response_schema_activity, fetch_claude_max_token_activity
from helpers.attachments import resolve_attachments_activity
from helpers.messages import update_agent_tree_state
from helpers.save_tool_usage import save_tool_usage
from tools.spawn_agent import spawn_explore_agent_activity, fetch_full_network_metadata
from tools.wait_for import evaluate_condition_activity
from helpers.query_parent_state import query_parent_state_activity, set_temporal_client
from tools.grep import grep_activity, fetch_local_data_summary
from helpers.update_tokens import update_agent_tokens_activity, update_agent_tree_cost_activity
from helpers.sms_activities import (
    get_agent_source,
    send_direct_sms_activity,
    notify_sms_event_activity,
)
# DAG executor activities
from activities.param_populator import populate_tool_params_activity
from activities.reasoning import execute_reasoning_activity
# Shared memory activities
from activities.shared_memory import get_shared_memory, append_shared_memory
from health_server import run_health_server, set_worker_status, set_queue_metrics

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
logging.getLogger('browser_use').setLevel(logging.INFO)
logging.getLogger('browser_use.browser').setLevel(logging.INFO)
logging.getLogger('cdp_use').setLevel(logging.WARNING)
logging.getLogger('cdp_use.client').setLevel(logging.WARNING)
logging.getLogger('cdp_use.cdp').setLevel(logging.WARNING)
logging.getLogger('cdp_use.cdp.registry').setLevel(logging.WARNING)
logging.getLogger('websockets.client').setLevel(logging.WARNING)
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)
logging.getLogger('temporalio.activity').setLevel(logging.WARNING)
logging.getLogger('temporalio.worker').setLevel(logging.WARNING)

# Disable Temporal's default message appending (workflow details are now in structured fields)
from temporalio import workflow as _wf
_wf.logger.workflow_info_on_message = False

logger = structlog.get_logger()


import httpx
import math
import socket
import time

# ── Adaptive autoscaler ──────────────────────────────────────────────────
# Built-in controller: no separate autoscaler machine needed.
# Every worker polls Temporal (1s), computes desired fleet size.
# Only the leader (lowest-IP via Fly DNS) actuates via Fly Machines API.
#
# Capacity is observed in real-time from the SDK's resource-based tuner
# (worker_task_slots_used + worker_task_slots_available on localhost:9090).
# No hardcoded magic numbers — the tuner adjusts slots based on CPU/memory.
#
# Scale-up (eager):   backlog >= 20% of observed capacity → add machines
# Scale-down (probe): 60s of zero backlog → remove 1 machine, watch for backlog
# ─────────────────────────────────────────────────────────────────────────

MIN_MACHINES = 2
MAX_MACHINES = 10
SCALE_DOWN_COOLDOWN_SECS = 60   # Seconds of zero backlog before probing downward
SCALE_UP_THRESHOLD = 0.2        # Fraction of machine capacity that triggers scale-up
SCALE_UP_COOLDOWN_SECS = 10     # Seconds to wait after a scale-up before allowing another
POLL_INTERVAL_SECS = 1          # 3 Temporal API calls/s — well within 1000 req/s limit
LOG_INTERVAL_SECS = 30          # Periodic summary log (avoid 86k lines/day at 1s polls)
SDK_METRICS_PORT = int(os.getenv("SDK_METRICS_PORT", "9090"))
DEFAULT_CAPACITY = 50  # Fallback when SDK metrics not yet available (matches max_concurrent_activities)

FLY_MACHINES_API = "https://api.machines.dev/v1"

# Mutable state (single writer in poll loop)
_backlog_zero_since: float | None = None
_desired_machines: int = MIN_MACHINES
_last_log_time: float = 0
_last_scale_up_time: float = 0
_prev_desired: int = MIN_MACHINES


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


async def _get_observed_capacity(http: httpx.AsyncClient) -> int | None:
    """Read actual activity slot capacity from the SDK's resource-based tuner.

    The tuner dynamically adjusts available slots based on CPU/memory pressure.
    effective_capacity = slots_used + slots_available = what this machine can
    actually handle right now. No hardcoded magic number needed.

    Returns None if SDK metrics aren't ready yet (e.g., during startup).
    """
    try:
        resp = await http.get(f"http://localhost:{SDK_METRICS_PORT}/metrics", timeout=2.0)

        slots_used = None
        slots_available = None
        for line in resp.text.splitlines():
            if line.startswith("#"):
                continue
            if "task_slots_used" in line and "ActivityTask" in line:
                slots_used = int(float(line.split()[-1]))
            elif "task_slots_available" in line and "ActivityTask" in line:
                slots_available = int(float(line.split()[-1]))

        if slots_used is not None and slots_available is not None:
            return max(slots_used + slots_available, 1)
        return None
    except Exception as e:
        logger.warning("Failed to read SDK metrics", error=str(e))
        return None


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


async def poll_queue_metrics(client: Client, namespace: str, task_queue: str):
    """Adaptive autoscaler: poll Temporal, compute desired machines, actuate via Fly API.

    Runs on every worker at 1s intervals. All workers observe and compute
    desired_machine_count (exposed via /metrics for monitoring). Only the leader
    (lowest-IP machine via Fly internal DNS) actuates by calling the Fly Machines
    API to start/stop machines.

    Scale-up (eager):
      Capacity is observed in real-time from the SDK's resource-based tuner
      (worker_task_slots_used + worker_task_slots_available on localhost:9090).
      When backlog >= 20% of observed capacity, add ceil(backlog / capacity) machines.
      The 20% threshold absorbs transient blips; ceil() ensures we add enough
      machines once the threshold is crossed (0.2→+1, 1.2→+2).

    Scale-down (adaptive):
      When backlog stays at 0 for 60 consecutive seconds:
      - If no workflows running → go straight to MIN_MACHINES (fast drain)
      - If workflows still running → remove 1 machine and probe again after 60s
      If removing a machine causes backlog, we detect it within 1s and scale back up.

    No separate autoscaler machine needed — the navi-whisper-lux-autoscaler app
    can be decommissioned.
    """
    global _backlog_zero_since, _desired_machines, _last_log_time, _last_scale_up_time, _prev_desired

    from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest
    from temporalio.api.taskqueue.v1 import TaskQueue as TaskQueueProto
    from temporalio.api.enums.v1 import TaskQueueType

    async with httpx.AsyncClient(timeout=10.0) as http:
        while True:
            try:
                # ── Observe current state ─────────────────────────────────
                count_result = await client.count_workflows(
                    f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"'
                )
                workflow_count = count_result.count

                backlog = 0
                for task_type in [TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
                                  TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW]:
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

                # Get real capacity from SDK's resource-based tuner (no magic number)
                observed_capacity = await _get_observed_capacity(http)
                if observed_capacity is None:
                    observed_capacity = DEFAULT_CAPACITY  # SDK metrics not ready yet, use fallback

                current_machines = _count_fly_peers()
                is_leader = _am_i_leader()

                # ── Adaptive scaling decision ─────────────────────────────
                now = time.monotonic()
                if backlog > 0:
                    _backlog_zero_since = None
                    additional = backlog / observed_capacity
                    # Cooldown: after a scale-up, wait for DNS to propagate
                    # before allowing another (prevents overshoot)
                    in_cooldown = (now - _last_scale_up_time) < SCALE_UP_COOLDOWN_SECS
                    if additional >= SCALE_UP_THRESHOLD and not in_cooldown:
                        _desired_machines = current_machines + math.ceil(additional)
                    else:
                        _desired_machines = current_machines  # Transient blip or in cooldown
                else:
                    # Backlog is 0 — scale down after cooldown
                    if _backlog_zero_since is None:
                        _backlog_zero_since = now

                    if now - _backlog_zero_since >= SCALE_DOWN_COOLDOWN_SECS:
                        if workflow_count == 0:
                            # No work at all — go straight to minimum
                            _desired_machines = MIN_MACHINES
                        else:
                            # Workflows running but no backlog — probe -1
                            _desired_machines = current_machines - 1
                        _backlog_zero_since = now  # Reset timer for next probe
                    else:
                        _desired_machines = current_machines  # Hold steady

                _desired_machines = max(MIN_MACHINES, min(MAX_MACHINES, _desired_machines))

                set_queue_metrics(backlog, workflow_count, _desired_machines, current_machines, is_leader, observed_capacity)

                # ── Leader actuates ───────────────────────────────────────
                if is_leader and _desired_machines != current_machines:
                    if _desired_machines > current_machines:
                        _last_scale_up_time = time.monotonic()
                    await _scale_fleet(_desired_machines, http)

                # ── Smart logging (every 30s or on state change) ──────────
                now_mono = time.monotonic()
                if (_desired_machines != _prev_desired or
                        now_mono - _last_log_time >= LOG_INTERVAL_SECS):
                    logger.info(
                        "Autoscaler poll",
                        backlog=backlog,
                        workflow_count=workflow_count,
                        current_machines=current_machines,
                        desired_machines=_desired_machines,
                        observed_capacity=observed_capacity,
                        is_leader=is_leader,
                    )
                    _last_log_time = now_mono
                _prev_desired = _desired_machines

            except Exception as e:
                logger.warning("Failed to poll queue metrics", error=str(e))

            await asyncio.sleep(POLL_INTERVAL_SECS)


async def main():
    """Main worker entry point."""

    # Load configuration
    config = load_config()

    # Log environment mode
    is_production = config.environment == "production"
    print(f"🚀 [Agents] Mode: {'PRODUCTION' if is_production else 'DEVELOPMENT'}")
    print(f"   Rose API URL: {config.rose.api_url}")

    # Set up Temporal SDK runtime with Prometheus metrics exporter.
    # Exposes worker_task_slots_used/available from the resource-based tuner
    # on a local port. The autoscaler scrapes these to get real capacity.
    runtime = Runtime(telemetry=TelemetryConfig(
        metrics=PrometheusConfig(bind_address=f"0.0.0.0:{SDK_METRICS_PORT}")
    ))

    # Start health check server
    health_thread = run_health_server(config.health_check_port)
    set_worker_status(True)

    logger.info(
        "Starting Temporal worker",
        namespace=config.temporal.namespace,
        task_queue=config.temporal.task_queue,
        environment=config.environment
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
            "Authorization": f"Bearer {config.temporal.api_key}"
        },
        runtime=runtime,
    )
    
    logger.info("Connected to Temporal Cloud")

    # Start background queue metrics poller (feeds /metrics for fly-autoscaler)
    asyncio.create_task(poll_queue_metrics(
        client, config.temporal.namespace, config.temporal.task_queue
    ))

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
    
    # Resource-based tuner: dynamically adjusts slot counts based on actual
    # CPU/memory pressure. No hardcoded concurrency limits — the tuner determines
    # how many concurrent activities/workflows this machine can handle in real-time.
    # The autoscaler reads the resulting slots via SDK Prometheus metrics.
    tuner = WorkerTuner.create_resource_based(
        target_memory_usage=0.8,
        target_cpu_usage=0.8,
        activity_config=ResourceBasedSlotConfig(
            maximum_slots=config.temporal.max_concurrent_activities,
        ),
        workflow_config=ResourceBasedSlotConfig(
            maximum_slots=config.temporal.max_concurrent_workflows,
        ),
    )

    # Create worker with all workflows and activities
    worker = Worker(
        client,
        task_queue=config.temporal.task_queue,
        workflows=[
            AgentWorkflow
        ],
        activities=[
            spawn_sub_agent_activity,
            create_approval_request_activity,
            send_sms_activity,
            spawn_browser_agent_activity_v3,  # V3: browser-use + Rose API
            spawn_claude_code_activity,  # Claude Code in E2B sandbox
            send_email_activity,
            # New event-driven tool activities
            deep_research_activity,
            web_search_activity,
            web_fetch_activity,
            people_search_activity,
            # Find All activities (split into sub-activities)
            find_all_ingest_activity,
            find_all_create_run_activity,
            find_all_poll_status_once_activity,
            find_all_get_results_activity,
            # Enrich activities (split into sub-activities)
            enrich_create_task_activity,
            enrich_poll_status_once_activity,
            enrich_get_task_results_activity,
            monitor_activity,
            check_monitor_events_activity,
            save_tool_usage,
            search_user_network_activity,
            read_message_history_activity,
            generate_message_activity,
            fetch_recent_messages_activity,
            # x402 Bazaar activities
            search_x402_bazaar_activity,
            pay_for_x402_service_activity,
            # Phone call activity
            call_phone_number_activity,
            # iMessage queue activity
            queue_imessage_activity,
            # Helper activities
            poll_new_messages,
            post_agent_message,
            call_llm,
            check_progress,
            call_llm_activity,
            call_planner_llm_activity,
            set_response_schema_activity,
            fetch_claude_max_token_activity,
            update_agent_status,
            compress_context,
            generate_completion_summary,
            spawn_explore_agent_activity,
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
            fetch_model_pricing,
            check_user_usage,
            get_user_context,
            get_user_system_name,
            get_user_custom_system_prompt,
            update_agent_tokens_activity,
            update_agent_tree_cost_activity,
            update_agent_tree_state,
            # SMS activities
            get_agent_source,
            send_direct_sms_activity,
            notify_sms_event_activity,
            # DAG executor activities
            populate_tool_params_activity,
            execute_reasoning_activity,
            # Shared memory activities
            get_shared_memory,
            append_shared_memory,
            # Parent state query (for sub-agent → parent communication)
            query_parent_state_activity,
        ],
        tuner=tuner,
        max_cached_workflows=config.temporal.max_cached_workflows,
        max_concurrent_activity_task_polls=config.temporal.max_concurrent_activity_task_polls,
        max_concurrent_workflow_task_polls=config.temporal.max_concurrent_workflow_task_polls,
        workflow_runner=SandboxedWorkflowRunner(restrictions=sandbox_restrictions),
    )
    
    logger.info(
        "Worker configured with resource-based tuner",
        max_activity_slots=config.temporal.max_concurrent_activities,
        max_workflow_slots=config.temporal.max_concurrent_workflows,
        target_cpu=0.8,
        target_memory=0.8,
    )
    
    # Handle shutdown gracefully using asyncio signal handlers
    loop = asyncio.get_running_loop()
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
        done, pending = await asyncio.wait(
            [worker_task, shutdown_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        
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
        logger.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())

