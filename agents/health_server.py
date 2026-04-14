"""Health check HTTP server for fly.io monitoring."""

import threading
from datetime import datetime

import psutil
import structlog
from flask import Flask, jsonify

logger = structlog.get_logger()

app = Flask(__name__)

# Global state
worker_status = {
    "healthy": True,
    "started_at": datetime.utcnow().isoformat(),
    "last_heartbeat": datetime.utcnow().isoformat(),
}

# Reuse process handle so CPU deltas are computed between scrapes.
_process = psutil.Process()
_process.cpu_percent(interval=None)

# Queue metrics (updated by background poller in worker.py)
_task_queue_backlog = 0
_running_workflow_count = 0
_desired_machine_count = 2  # Adaptive autoscaler output (min=2)
_current_machine_count = 1  # Observed via Fly DNS
_is_leader = False  # Whether this instance is the autoscaler leader
_observed_task_capacity = 0  # Dynamic capacity from SDK resource-based tuner


def set_queue_metrics(
    backlog: int,
    workflow_count: int,
    desired_machines: int,
    current_machines: int,
    is_leader: bool = False,
    observed_capacity: int = 0,
):
    """Update queue metrics from background poller. Thread-safe via GIL."""
    global \
        _task_queue_backlog, \
        _running_workflow_count, \
        _desired_machine_count, \
        _current_machine_count, \
        _is_leader, \
        _observed_task_capacity
    _task_queue_backlog = backlog
    _running_workflow_count = workflow_count
    _desired_machine_count = desired_machines
    _current_machine_count = current_machines
    _is_leader = is_leader
    _observed_task_capacity = observed_capacity


@app.route("/health")
def health():
    """Health check endpoint."""
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()

    if worker_status["healthy"]:
        return jsonify({"status": "healthy", "worker": "running", **worker_status}), 200
    else:
        return jsonify({"status": "unhealthy", "worker": "stopped", **worker_status}), 503


@app.route("/metrics")
def metrics():
    """Metrics endpoint (basic Prometheus format)."""
    uptime = (datetime.utcnow() - datetime.fromisoformat(worker_status["started_at"])).total_seconds()
    process_cpu_percent = _process.cpu_percent(interval=None)

    metrics_text = f"""# HELP worker_healthy Worker health status (1=healthy, 0=unhealthy)
# TYPE worker_healthy gauge
worker_healthy {1 if worker_status["healthy"] else 0}

# HELP worker_uptime_seconds Worker uptime in seconds
# TYPE worker_uptime_seconds counter
worker_uptime_seconds {uptime}

# HELP worker_process_cpu_percent Process CPU usage percent since last scrape
# TYPE worker_process_cpu_percent gauge
worker_process_cpu_percent {process_cpu_percent}

# HELP task_queue_backlog Approximate tasks waiting in Temporal task queue (activity + workflow)
# TYPE task_queue_backlog gauge
task_queue_backlog {_task_queue_backlog}

# HELP running_workflow_count Number of currently running Temporal workflows
# TYPE running_workflow_count gauge
running_workflow_count {_running_workflow_count}

# HELP desired_machine_count Adaptive autoscaler: desired number of Fly machines
# TYPE desired_machine_count gauge
desired_machine_count {_desired_machine_count}

# HELP current_machine_count Observed Fly machine count via internal DNS
# TYPE current_machine_count gauge
current_machine_count {_current_machine_count}

# HELP autoscaler_is_leader Whether this instance is the autoscaler leader (1=leader, 0=follower)
# TYPE autoscaler_is_leader gauge
autoscaler_is_leader {1 if _is_leader else 0}

# HELP observed_task_capacity Dynamic activity task capacity per machine (from SDK resource-based tuner)
# TYPE observed_task_capacity gauge
observed_task_capacity {_observed_task_capacity}
"""

    return metrics_text, 200, {"Content-Type": "text/plain; charset=utf-8"}


def set_worker_status(healthy: bool):
    """Update worker health status."""
    worker_status["healthy"] = healthy
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()


def run_health_server(port: int = 8080):
    """Run the health check server in a separate thread."""
    logger.info(f"Starting health check server on port {port}")

    # Run in a separate thread so it doesn't block the worker
    server_thread = threading.Thread(target=lambda: app.run(host="0.0.0.0", port=port, debug=False), daemon=True)
    server_thread.start()

    logger.info(f"Health check server running at http://0.0.0.0:{port}/health")

    return server_thread


if __name__ == "__main__":
    # For testing
    run_health_server()
    import time

    time.sleep(60)
