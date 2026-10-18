"""Health check HTTP server for fly.io monitoring."""

import ctypes
import gc
import importlib
import os
import sys
import threading
import time
from datetime import datetime
from typing import Optional

import psutil
import structlog
from flask import Flask, jsonify
from werkzeug.serving import make_server

logger = structlog.get_logger()

app = Flask(__name__)

# Global state
worker_status = {
    "healthy": False,
    "phase": "starting",
    "build_id": None,
    "started_at": datetime.utcnow().isoformat(),
    "last_heartbeat": datetime.utcnow().isoformat(),
}

# Reuse process handle so CPU deltas are computed between scrapes.
_process = psutil.Process()
_process.cpu_percent(interval=None)

_BENCHMARK_MEMORY_MODULES = (
    "domains.spawn_browser_agent_v3.handler",
    "domains.spawn_claude_code_agent.service",
    "providers.rose.browser_use",
)


def _min_machines_floor() -> int:
    """Parse MIN_MACHINES defensively: a malformed value must not take the
    health server down at import time, and the floor is never below 1."""
    raw = os.getenv("MIN_MACHINES", "2")
    try:
        value = int(raw)
    except ValueError:
        logger.warning(f"Invalid MIN_MACHINES value {raw!r} — falling back to 2")
        value = 2
    return max(value, 1)


# Queue metrics (updated by background poller in worker.py). None = unknown:
# this worker has no current observation (a follower without a leader view, or
# an observer whose Temporal calls failed). Unknown is published as NaN, never 0,
# because a zero backlog is a scale-down signal.
_task_queue_backlog: Optional[int] = None
_running_workflow_count: Optional[int] = None
_queue_metrics_observed_at: Optional[float] = None  # time.monotonic() of the observation
_queue_metrics_source: Optional[str] = None  # "self" (this worker's Temporal calls) | "leader" (mirrored)
# Leader election state (worker.py). Peers read it from /autoscaler/peer.
_autoscaler_role: Optional[str] = None  # "leader" | "follower" | "unknown"
_autoscaler_leader_eligible = False
_autoscaler_observes_queue = False
_local_metrics_published_at: Optional[float] = None  # time.monotonic() of the last local reading
# Pre-computed floor; matches worker MIN_MACHINES (prod=2, per-bench cloud=1).
_desired_machine_count = _min_machines_floor()
_current_machine_count = 1  # Observed via Fly DNS
_is_leader = False  # Whether this instance is the autoscaler leader
_observed_task_capacity: Optional[int] = None  # Dynamic capacity from SDK resource-based tuner
_activity_slots_used: Optional[int] = None
_activity_slots_available: Optional[int] = None
_resource_slots_cpu_usage: Optional[float] = None
_resource_slots_mem_usage: Optional[float] = None
_resource_slots_cpu_pid_output: Optional[float] = None
_resource_slots_mem_pid_output: Optional[float] = None
_activity_task_pollers: Optional[int] = None
_workflow_task_pollers: Optional[int] = None
_sticky_workflow_task_pollers: Optional[int] = None
_activity_admission_open: Optional[bool] = None
_activity_admission_memory_percent: Optional[float] = None
_activity_admission_close_memory_percent: Optional[float] = None
_activity_admission_open_memory_percent: Optional[float] = None
_machine_memory_used_percent = 0.0
_autoscaler_memory_threshold_percent = 80.0
_autoscaler_memory_signal_percent = 0.0


def _process_tree_rss_bytes() -> tuple[int, int]:
    """Return RSS bytes for this process and all currently alive children."""
    process_rss = _process.memory_info().rss
    child_rss = 0
    for child in _process.children(recursive=True):
        try:
            child_rss += child.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return process_rss, child_rss


def _trim_process_memory() -> bool:
    """Ask the platform allocator to release free arenas when supported."""
    if sys.platform == "darwin":
        try:
            libc = ctypes.CDLL(None)
            libc.malloc_default_zone.restype = ctypes.c_void_p
            zone = libc.malloc_default_zone()
            libc.malloc_zone_pressure_relief.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            libc.malloc_zone_pressure_relief.restype = ctypes.c_size_t
            return libc.malloc_zone_pressure_relief(zone, 0) > 0
        except Exception:
            return False

    try:
        libc = ctypes.CDLL("libc.so.6")
        return bool(libc.malloc_trim(0))
    except Exception:
        return False


def _benchmark_memory_baseline() -> dict:
    """Warm smoke-only lazy imports, then collect memory before RSS sampling."""
    imported: list[str] = []
    import_errors: dict[str, str] = {}
    before_process_rss, before_child_rss = _process_tree_rss_bytes()

    for module_name in _BENCHMARK_MEMORY_MODULES:
        try:
            importlib.import_module(module_name)
            imported.append(module_name)
        except Exception as exc:
            import_errors[module_name] = str(exc)

    collected = gc.collect()
    collected += gc.collect()
    allocator_trimmed = _trim_process_memory()
    after_process_rss, after_child_rss = _process_tree_rss_bytes()

    return {
        "imported": imported,
        "import_errors": import_errors,
        "gc_collected": collected,
        "allocator_trimmed": allocator_trimmed,
        "before_process_rss_bytes": before_process_rss,
        "before_child_rss_bytes": before_child_rss,
        "after_process_rss_bytes": after_process_rss,
        "after_child_rss_bytes": after_child_rss,
    }


def set_queue_metrics(
    backlog: int,
    workflow_count: int,
    desired_machines: int,
    current_machines: int,
    is_leader: bool = False,
    observed_capacity: Optional[int] = None,
    activity_slots_used: Optional[int] = None,
    activity_slots_available: Optional[int] = None,
    machine_memory_used_percent: float = 0.0,
    autoscaler_memory_threshold_percent: float = 80.0,
    autoscaler_memory_signal_percent: float = 0.0,
    resource_slots_cpu_usage: Optional[float] = None,
    resource_slots_mem_usage: Optional[float] = None,
    resource_slots_cpu_pid_output: Optional[float] = None,
    resource_slots_mem_pid_output: Optional[float] = None,
    activity_task_pollers: Optional[int] = None,
    workflow_task_pollers: Optional[int] = None,
    sticky_workflow_task_pollers: Optional[int] = None,
    activity_admission_open: Optional[bool] = None,
    activity_admission_memory_percent: Optional[float] = None,
    activity_admission_close_memory_percent: Optional[float] = None,
    activity_admission_open_memory_percent: Optional[float] = None,
):
    """Update queue metrics from background poller. Thread-safe via GIL."""
    global \
        _desired_machine_count, \
        _current_machine_count, \
        _is_leader, \
        _observed_task_capacity, \
        _activity_slots_used, \
        _activity_slots_available, \
        _resource_slots_cpu_usage, \
        _resource_slots_mem_usage, \
        _resource_slots_cpu_pid_output, \
        _resource_slots_mem_pid_output, \
        _activity_task_pollers, \
        _workflow_task_pollers, \
        _sticky_workflow_task_pollers, \
        _activity_admission_open, \
        _activity_admission_memory_percent, \
        _activity_admission_close_memory_percent, \
        _activity_admission_open_memory_percent, \
        _machine_memory_used_percent, \
        _autoscaler_memory_threshold_percent, \
        _autoscaler_memory_signal_percent
    _record_queue_observation(backlog, workflow_count, source="self", age_seconds=0.0)
    _desired_machine_count = desired_machines
    _current_machine_count = current_machines
    _is_leader = is_leader
    _observed_task_capacity = observed_capacity
    _activity_slots_used = activity_slots_used
    _activity_slots_available = activity_slots_available
    _resource_slots_cpu_usage = resource_slots_cpu_usage
    _resource_slots_mem_usage = resource_slots_mem_usage
    _resource_slots_cpu_pid_output = resource_slots_cpu_pid_output
    _resource_slots_mem_pid_output = resource_slots_mem_pid_output
    _activity_task_pollers = activity_task_pollers
    _workflow_task_pollers = workflow_task_pollers
    _sticky_workflow_task_pollers = sticky_workflow_task_pollers
    _activity_admission_open = activity_admission_open
    _activity_admission_memory_percent = activity_admission_memory_percent
    _activity_admission_close_memory_percent = activity_admission_close_memory_percent
    _activity_admission_open_memory_percent = activity_admission_open_memory_percent
    _machine_memory_used_percent = machine_memory_used_percent
    _autoscaler_memory_threshold_percent = autoscaler_memory_threshold_percent
    _autoscaler_memory_signal_percent = autoscaler_memory_signal_percent


def _record_queue_observation(
    backlog: Optional[int], workflow_count: Optional[int], *, source: str, age_seconds: float
) -> None:
    global _task_queue_backlog, _running_workflow_count, _queue_metrics_observed_at, _queue_metrics_source
    if backlog is None or workflow_count is None:
        _task_queue_backlog = None
        _running_workflow_count = None
        _queue_metrics_observed_at = None
        _queue_metrics_source = None
        return
    _task_queue_backlog = int(backlog)
    _running_workflow_count = int(workflow_count)
    _queue_metrics_observed_at = time.monotonic() - max(float(age_seconds), 0.0)
    _queue_metrics_source = source


def set_queue_observation(
    backlog: Optional[int],
    workflow_count: Optional[int],
    *,
    desired_machines: int,
    current_machines: int,
    age_seconds: float = 0.0,
    source: str = "self",
    autoscaler_memory_signal_percent: Optional[float] = None,
    autoscaler_memory_threshold_percent: Optional[float] = None,
) -> None:
    """Publish the Temporal queue observation; None backlog/count means unknown."""
    global \
        _desired_machine_count, \
        _current_machine_count, \
        _autoscaler_memory_signal_percent, \
        _autoscaler_memory_threshold_percent
    _record_queue_observation(backlog, workflow_count, source=source, age_seconds=age_seconds)
    _desired_machine_count = int(desired_machines)
    _current_machine_count = int(current_machines)
    if autoscaler_memory_signal_percent is not None:
        _autoscaler_memory_signal_percent = autoscaler_memory_signal_percent
    if autoscaler_memory_threshold_percent is not None:
        _autoscaler_memory_threshold_percent = autoscaler_memory_threshold_percent


def set_local_autoscaler_metrics(
    *,
    machine_memory_used_percent: float,
    observed_capacity: Optional[int] = None,
    activity_slots_used: Optional[int] = None,
    activity_slots_available: Optional[int] = None,
    resource_slots_cpu_usage: Optional[float] = None,
    resource_slots_mem_usage: Optional[float] = None,
    resource_slots_cpu_pid_output: Optional[float] = None,
    resource_slots_mem_pid_output: Optional[float] = None,
    activity_task_pollers: Optional[int] = None,
    workflow_task_pollers: Optional[int] = None,
    sticky_workflow_task_pollers: Optional[int] = None,
    activity_admission_open: Optional[bool] = None,
    activity_admission_memory_percent: Optional[float] = None,
    activity_admission_close_memory_percent: Optional[float] = None,
    activity_admission_open_memory_percent: Optional[float] = None,
) -> None:
    """Publish this machine's own readings. Needs no Temporal call, so it never
    waits behind (or freezes with) the queue observation."""
    global \
        _machine_memory_used_percent, \
        _observed_task_capacity, \
        _activity_slots_used, \
        _activity_slots_available, \
        _resource_slots_cpu_usage, \
        _resource_slots_mem_usage, \
        _resource_slots_cpu_pid_output, \
        _resource_slots_mem_pid_output, \
        _activity_task_pollers, \
        _workflow_task_pollers, \
        _sticky_workflow_task_pollers, \
        _activity_admission_open, \
        _activity_admission_memory_percent, \
        _activity_admission_close_memory_percent, \
        _activity_admission_open_memory_percent, \
        _local_metrics_published_at
    _machine_memory_used_percent = machine_memory_used_percent
    _observed_task_capacity = observed_capacity
    _activity_slots_used = activity_slots_used
    _activity_slots_available = activity_slots_available
    _resource_slots_cpu_usage = resource_slots_cpu_usage
    _resource_slots_mem_usage = resource_slots_mem_usage
    _resource_slots_cpu_pid_output = resource_slots_cpu_pid_output
    _resource_slots_mem_pid_output = resource_slots_mem_pid_output
    _activity_task_pollers = activity_task_pollers
    _workflow_task_pollers = workflow_task_pollers
    _sticky_workflow_task_pollers = sticky_workflow_task_pollers
    _activity_admission_open = activity_admission_open
    _activity_admission_memory_percent = activity_admission_memory_percent
    _activity_admission_close_memory_percent = activity_admission_close_memory_percent
    _activity_admission_open_memory_percent = activity_admission_open_memory_percent
    _local_metrics_published_at = time.monotonic()


def set_autoscaler_role(role: Optional[str], *, leader_eligible: bool, observes_queue: bool) -> None:
    """Publish this worker's election state for peers and dashboards."""
    global _autoscaler_role, _autoscaler_leader_eligible, _autoscaler_observes_queue, _is_leader
    _autoscaler_role = role
    _autoscaler_leader_eligible = bool(leader_eligible)
    _autoscaler_observes_queue = bool(observes_queue)
    _is_leader = role == "leader"


def _age_seconds(at: Optional[float]) -> Optional[float]:
    return None if at is None else max(time.monotonic() - at, 0.0)


def autoscaler_peer_view() -> dict:
    """The view peers elect the observing leader from (served at /autoscaler/peer).

    Only this worker's own observation is advertised as `queue`: a mirrored copy
    is never re-advertised, so a stale value cannot propagate down a chain.
    """
    queue = None
    if _queue_metrics_source == "self" and _task_queue_backlog is not None:
        queue = {
            "backlog": _task_queue_backlog,
            "workflow_count": _running_workflow_count,
            "desired_machines": _desired_machine_count,
            "current_machines": _current_machine_count,
            "age_seconds": _age_seconds(_queue_metrics_observed_at),
            "source": "self",
        }
    return {
        "surface_hash": (os.getenv("TEMPORAL_WORKER_SURFACE_HASH") or "").strip(),
        "role": _autoscaler_role,
        "leader_eligible": _autoscaler_leader_eligible,
        "heartbeat_age_seconds": _age_seconds(_local_metrics_published_at),
        "machine_memory_used_percent": (
            _machine_memory_used_percent if _local_metrics_published_at is not None else None
        ),
        "activity_admission_open": _activity_admission_open,
        "activity_slots_used": _activity_slots_used,
        "queue": queue,
    }


def get_queue_metrics_snapshot() -> dict:
    """Return the latest queue/worker-capacity snapshot for trace metadata."""
    snapshot = {
        "task_queue_backlog": _task_queue_backlog,
        "running_workflow_count": _running_workflow_count,
        "task_queue_metrics_source": _queue_metrics_source,
        "task_queue_metrics_age_seconds": _age_seconds(_queue_metrics_observed_at),
        "autoscaler_role": _autoscaler_role,
        "desired_machine_count": _desired_machine_count,
        "current_machine_count": _current_machine_count,
        "autoscaler_is_leader": _is_leader,
        "observed_task_capacity": _observed_task_capacity,
        "activity_slots_used": _activity_slots_used,
        "activity_slots_available": _activity_slots_available,
        "machine_memory_used_percent": _machine_memory_used_percent,
        "autoscaler_memory_threshold_percent": _autoscaler_memory_threshold_percent,
        "autoscaler_memory_signal_percent": _autoscaler_memory_signal_percent,
        "resource_slots_cpu_usage": _resource_slots_cpu_usage,
        "resource_slots_mem_usage": _resource_slots_mem_usage,
        "resource_slots_cpu_pid_output": _resource_slots_cpu_pid_output,
        "resource_slots_mem_pid_output": _resource_slots_mem_pid_output,
        "activity_task_pollers": _activity_task_pollers,
        "workflow_task_pollers": _workflow_task_pollers,
        "sticky_workflow_task_pollers": _sticky_workflow_task_pollers,
        "activity_admission_open": _activity_admission_open,
        "activity_admission_memory_percent": _activity_admission_memory_percent,
        "activity_admission_close_memory_percent": _activity_admission_close_memory_percent,
        "activity_admission_open_memory_percent": _activity_admission_open_memory_percent,
    }
    return {key: value for key, value in snapshot.items() if value is not None}


def _prom_value(value: Optional[float | int]) -> str:
    return "NaN" if value is None else str(value)


def _prom_present(value: object) -> int:
    return 0 if value is None else 1


@app.route("/health")
def health():
    """Health check endpoint."""
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()

    if worker_status["healthy"]:
        return jsonify({"status": "healthy", "worker": worker_status["phase"], **worker_status}), 200
    else:
        return jsonify({"status": "unhealthy", "worker": worker_status["phase"], **worker_status}), 503


@app.route("/metrics")
def metrics():
    """Metrics endpoint (basic Prometheus format)."""
    uptime = (datetime.utcnow() - datetime.fromisoformat(worker_status["started_at"])).total_seconds()
    process_cpu_percent = _process.cpu_percent(interval=None)
    process_rss_bytes, child_rss_bytes = _process_tree_rss_bytes()
    tree_rss_bytes = process_rss_bytes + child_rss_bytes
    vm = psutil.virtual_memory()

    metrics_text = f"""# HELP worker_healthy Worker health status (1=healthy, 0=unhealthy)
# TYPE worker_healthy gauge
worker_healthy {1 if worker_status["healthy"] else 0}

# HELP worker_polling Whether this process is polling its Temporal task queue
# TYPE worker_polling gauge
worker_polling {1 if worker_status["phase"] == "running" else 0}

# HELP worker_uptime_seconds Worker uptime in seconds
# TYPE worker_uptime_seconds counter
worker_uptime_seconds {uptime}

# HELP worker_process_cpu_percent Process CPU usage percent since last scrape
# TYPE worker_process_cpu_percent gauge
worker_process_cpu_percent {process_cpu_percent}

# HELP worker_process_rss_bytes Resident set size of the Python worker process
# TYPE worker_process_rss_bytes gauge
worker_process_rss_bytes {process_rss_bytes}

# HELP worker_child_process_rss_bytes Resident set size of child processes spawned by the worker
# TYPE worker_child_process_rss_bytes gauge
worker_child_process_rss_bytes {child_rss_bytes}

# HELP worker_process_tree_rss_bytes Resident set size of the worker process plus child processes
# TYPE worker_process_tree_rss_bytes gauge
worker_process_tree_rss_bytes {tree_rss_bytes}

# HELP machine_memory_total_bytes Total memory visible to the worker process
# TYPE machine_memory_total_bytes gauge
machine_memory_total_bytes {vm.total}

# HELP machine_memory_available_bytes Available memory visible to the worker process
# TYPE machine_memory_available_bytes gauge
machine_memory_available_bytes {vm.available}

# HELP machine_memory_used_percent Memory usage percent visible to the worker process
# TYPE machine_memory_used_percent gauge
machine_memory_used_percent {_machine_memory_used_percent or vm.percent}

# HELP task_queue_backlog Approximate tasks waiting in Temporal task queue (activity + workflow); NaN when unobserved
# TYPE task_queue_backlog gauge
task_queue_backlog {_prom_value(_task_queue_backlog)}

# HELP running_workflow_count Number of currently running Temporal workflows; NaN when unobserved
# TYPE running_workflow_count gauge
running_workflow_count {_prom_value(_running_workflow_count)}

# HELP task_queue_metrics_present Whether task_queue_backlog/running_workflow_count hold a current observation
# TYPE task_queue_metrics_present gauge
task_queue_metrics_present {_prom_present(_task_queue_backlog)}

# HELP task_queue_metrics_age_seconds Age of the published queue observation (NaN when unobserved)
# TYPE task_queue_metrics_age_seconds gauge
task_queue_metrics_age_seconds {_prom_value(_age_seconds(_queue_metrics_observed_at))}

# HELP desired_machine_count Adaptive autoscaler: desired number of Fly machines
# TYPE desired_machine_count gauge
desired_machine_count {_desired_machine_count}

# HELP current_machine_count Observed Fly machine count via internal DNS
# TYPE current_machine_count gauge
current_machine_count {_current_machine_count}

# HELP autoscaler_is_leader Whether this instance is the autoscaler leader (1=leader, 0=follower)
# TYPE autoscaler_is_leader gauge
autoscaler_is_leader {1 if _is_leader else 0}

# HELP autoscaler_leadership_known Whether this instance verified its leader/follower role (0=unknown)
# TYPE autoscaler_leadership_known gauge
autoscaler_leadership_known {1 if _autoscaler_role in ("leader", "follower") else 0}

# HELP autoscaler_observes_queue Whether this instance itself spends Temporal visibility calls on the queue
# TYPE autoscaler_observes_queue gauge
autoscaler_observes_queue {1 if _autoscaler_observes_queue else 0}

# HELP observed_task_capacity Dynamic activity task capacity per machine (from SDK resource-based tuner)
# TYPE observed_task_capacity gauge
observed_task_capacity {_prom_value(_observed_task_capacity)}

# HELP observed_task_capacity_present Whether observed_task_capacity was emitted by the SDK scrape
# TYPE observed_task_capacity_present gauge
observed_task_capacity_present {_prom_present(_observed_task_capacity)}

# HELP activity_slots_used Current activity task slots in use on this worker
# TYPE activity_slots_used gauge
activity_slots_used {_prom_value(_activity_slots_used)}

# HELP activity_slots_available Current activity task slots available on this worker
# TYPE activity_slots_available gauge
activity_slots_available {_prom_value(_activity_slots_available)}

# HELP activity_slots_available_present Whether activity_slots_available was emitted by the SDK scrape
# TYPE activity_slots_available_present gauge
activity_slots_available_present {_prom_present(_activity_slots_available)}

# HELP resource_slots_cpu_usage Temporal SDK resource slot tuner CPU usage signal
# TYPE resource_slots_cpu_usage gauge
resource_slots_cpu_usage {_prom_value(_resource_slots_cpu_usage)}

# HELP resource_slots_mem_usage Temporal SDK resource slot tuner memory usage signal
# TYPE resource_slots_mem_usage gauge
resource_slots_mem_usage {_prom_value(_resource_slots_mem_usage)}

# HELP resource_slots_cpu_pid_output Temporal SDK resource slot tuner CPU PID controller output
# TYPE resource_slots_cpu_pid_output gauge
resource_slots_cpu_pid_output {_prom_value(_resource_slots_cpu_pid_output)}

# HELP resource_slots_mem_pid_output Temporal SDK resource slot tuner memory PID controller output
# TYPE resource_slots_mem_pid_output gauge
resource_slots_mem_pid_output {_prom_value(_resource_slots_mem_pid_output)}

# HELP activity_task_pollers Temporal SDK activity task poller count
# TYPE activity_task_pollers gauge
activity_task_pollers {_prom_value(_activity_task_pollers)}

# HELP activity_admission_open Whether this worker is accepting new activity tasks (1=open, 0=closed)
# TYPE activity_admission_open gauge
activity_admission_open {_prom_value(None if _activity_admission_open is None else int(_activity_admission_open))}

# HELP activity_admission_memory_percent Memory percent used by the activity admission gate
# TYPE activity_admission_memory_percent gauge
activity_admission_memory_percent {_prom_value(_activity_admission_memory_percent)}

# HELP activity_admission_close_memory_percent Memory percent at which activity admission closes
# TYPE activity_admission_close_memory_percent gauge
activity_admission_close_memory_percent {_prom_value(_activity_admission_close_memory_percent)}

# HELP activity_admission_open_memory_percent Memory percent at which activity admission reopens
# TYPE activity_admission_open_memory_percent gauge
activity_admission_open_memory_percent {_prom_value(_activity_admission_open_memory_percent)}

# HELP workflow_task_pollers Temporal SDK workflow task poller count
# TYPE workflow_task_pollers gauge
workflow_task_pollers {_prom_value(_workflow_task_pollers)}

# HELP sticky_workflow_task_pollers Temporal SDK sticky workflow task poller count
# TYPE sticky_workflow_task_pollers gauge
sticky_workflow_task_pollers {_prom_value(_sticky_workflow_task_pollers)}

# HELP autoscaler_memory_threshold_percent Machine memory percentage that triggers autoscaler scale-up/hold behavior
# TYPE autoscaler_memory_threshold_percent gauge
autoscaler_memory_threshold_percent {_autoscaler_memory_threshold_percent}

# HELP autoscaler_memory_signal_percent Max machine memory percent considered by autoscaler
# TYPE autoscaler_memory_signal_percent gauge
autoscaler_memory_signal_percent {_autoscaler_memory_signal_percent or _machine_memory_used_percent or vm.percent}
"""

    return metrics_text, 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.route("/autoscaler/peer")
def autoscaler_peer():
    """Election/fleet view for peer workers on the private network (no Temporal call)."""
    return jsonify(autoscaler_peer_view()), 200


@app.route("/benchmark/memory-baseline", methods=["POST"])
def benchmark_memory_baseline():
    """Benchmark-only endpoint that stabilizes worker RSS before smoke sampling."""
    if os.environ.get("ENABLE_BENCHMARK_MEMORY_BASELINE") != "1":
        return jsonify({"error": "benchmark memory baseline disabled"}), 404
    return jsonify(_benchmark_memory_baseline()), 200


def set_worker_status(healthy: bool, phase: Optional[str] = None, build_id: Optional[str] = None):
    """Update worker health status."""
    worker_status["healthy"] = healthy
    worker_status["phase"] = phase or ("running" if healthy else "stopped")
    worker_status["build_id"] = build_id
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()


class HealthServerThread(threading.Thread):
    """A bound health endpoint whose port is known before worker startup proceeds."""

    def __init__(self, port: int):
        self.server = make_server("::", port, app, threaded=True)
        self.port = self.server.server_port
        super().__init__(target=self.server.serve_forever, daemon=True)


def run_health_server(port: int = 8080) -> HealthServerThread:
    """Bind the health endpoint, then serve it in a separate thread."""
    # Bind dual-stack (::) not 0.0.0.0. Fly's private 6PN network is IPv6-only,
    # and the autoscaler leader scrapes each peer's /metrics over IPv6
    # (http://[fdaa:...]:PORT/metrics, peer IPs resolved via AF_INET6 AAAA DNS).
    # An IPv4-only 0.0.0.0 bind is unreachable on the 6PN, so peer admission/CPU
    # scrapes fail ("All connection attempts failed") and the leader can only see
    # its own pressure → it under-scales the fleet. `::` accepts both IPv6 (peers)
    # and IPv4-mapped (local health checks) on Linux (bindv6only=0).
    server_thread = HealthServerThread(port)
    server_thread.start()

    logger.info(f"Health check server running at http://[::]:{server_thread.port}/health")

    return server_thread


if __name__ == "__main__":
    # For testing
    run_health_server()
    import time

    time.sleep(60)
