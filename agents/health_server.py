"""Health check HTTP server for fly.io monitoring."""

from flask import Flask, jsonify
import threading
from datetime import datetime
import structlog
import psutil

logger = structlog.get_logger()

app = Flask(__name__)

# Global state
worker_status = {
    "healthy": True,
    "started_at": datetime.utcnow().isoformat(),
    "last_heartbeat": datetime.utcnow().isoformat()
}

# Reuse process handle so CPU deltas are computed between scrapes.
_process = psutil.Process()
_process.cpu_percent(interval=None)


@app.route('/health')
def health():
    """Health check endpoint."""
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()
    
    if worker_status["healthy"]:
        return jsonify({
            "status": "healthy",
            "worker": "running",
            **worker_status
        }), 200
    else:
        return jsonify({
            "status": "unhealthy",
            "worker": "stopped",
            **worker_status
        }), 503


@app.route('/metrics')
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
"""
    
    return metrics_text, 200, {'Content-Type': 'text/plain; charset=utf-8'}


def set_worker_status(healthy: bool):
    """Update worker health status."""
    worker_status["healthy"] = healthy
    worker_status["last_heartbeat"] = datetime.utcnow().isoformat()


def run_health_server(port: int = 8080):
    """Run the health check server in a separate thread."""
    logger.info(f"Starting health check server on port {port}")
    
    # Run in a separate thread so it doesn't block the worker
    server_thread = threading.Thread(
        target=lambda: app.run(host='0.0.0.0', port=port, debug=False),
        daemon=True
    )
    server_thread.start()
    
    logger.info(f"Health check server running at http://0.0.0.0:{port}/health")
    
    return server_thread


if __name__ == "__main__":
    # For testing
    run_health_server()
    import time
    time.sleep(60)
