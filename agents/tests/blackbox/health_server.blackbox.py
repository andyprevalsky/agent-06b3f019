"""Blackbox tests for health_server domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


def test_health_endpoint():
    """GET /health is ready only while the Temporal worker is running."""
    from health_server import app, set_worker_status

    client = app.test_client()
    response = client.get("/health")

    assert response.status_code == 503
    data = response.get_json()
    assert data["status"] == "unhealthy"
    assert data["worker"] == "stopped"

    set_worker_status(True)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "healthy"
    assert data["worker"] == "running"

    set_worker_status(False)
    response = client.get("/health")
    assert response.status_code == 503


def test_metrics_endpoint():
    """GET /metrics returns 200 with Prometheus-format text containing temporal_queue_backlog."""
    from health_server import app

    client = app.test_client()
    response = client.get("/metrics")

    assert response.status_code == 200
    text = response.get_data(as_text=True)
    assert "task_queue_backlog" in text
    assert "running_workflow_count" in text
    assert "machine_memory_used_percent" in text
    assert "worker_process_tree_rss_bytes" in text
    assert "autoscaler_memory_signal_percent" in text
    assert "activity_slots_used" in text
    assert "activity_slots_available" in text
    assert "activity_slots_available_present" in text
    assert "resource_slots_cpu_usage" in text
    assert "resource_slots_mem_usage" in text
    assert "activity_task_pollers" in text
    assert "activity_admission_open" in text
    assert "activity_admission_memory_percent" in text


def test_set_queue_metrics():
    """set_queue_metrics updates values that appear in /metrics."""
    from health_server import app, set_queue_metrics

    set_queue_metrics(
        5,
        10,
        2,
        1,
        observed_capacity=12,
        activity_slots_used=9,
        activity_slots_available=3,
        machine_memory_used_percent=81.5,
        autoscaler_memory_threshold_percent=80,
        autoscaler_memory_signal_percent=87.2,
        resource_slots_cpu_usage=44.4,
        resource_slots_mem_usage=66.6,
        resource_slots_cpu_pid_output=1.25,
        resource_slots_mem_pid_output=0.75,
        activity_task_pollers=4,
        workflow_task_pollers=5,
        sticky_workflow_task_pollers=6,
        activity_admission_open=False,
        activity_admission_memory_percent=82.5,
        activity_admission_close_memory_percent=80,
        activity_admission_open_memory_percent=75,
    )

    client = app.test_client()
    response = client.get("/metrics")
    text = response.get_data(as_text=True)

    assert "task_queue_backlog 5" in text
    assert "running_workflow_count 10" in text
    assert "desired_machine_count 2" in text
    assert "current_machine_count 1" in text
    assert "observed_task_capacity 12" in text
    assert "activity_slots_used 9" in text
    assert "activity_slots_available 3" in text
    assert "machine_memory_used_percent 81.5" in text
    assert "autoscaler_memory_threshold_percent 80" in text
    assert "autoscaler_memory_signal_percent 87.2" in text
    assert "resource_slots_cpu_usage 44.4" in text
    assert "resource_slots_mem_usage 66.6" in text
    assert "resource_slots_cpu_pid_output 1.25" in text
    assert "resource_slots_mem_pid_output 0.75" in text
    assert "activity_task_pollers 4" in text
    assert "activity_admission_open 0" in text
    assert "activity_admission_memory_percent 82.5" in text
    assert "activity_admission_close_memory_percent 80" in text
    assert "activity_admission_open_memory_percent 75" in text
    assert "workflow_task_pollers 5" in text
    assert "sticky_workflow_task_pollers 6" in text

    from health_server import get_queue_metrics_snapshot

    snapshot = get_queue_metrics_snapshot()
    assert snapshot["task_queue_backlog"] == 5
    assert snapshot["activity_slots_used"] == 9
    assert snapshot["activity_slots_available"] == 3
    assert snapshot["resource_slots_cpu_usage"] == 44.4
    assert snapshot["resource_slots_mem_usage"] == 66.6
    assert snapshot["activity_task_pollers"] == 4
    assert snapshot["activity_admission_open"] is False
    assert snapshot["activity_admission_memory_percent"] == 82.5

    # Reset to defaults to avoid polluting other tests
    set_queue_metrics(0, 0, 2, 1)

    snapshot = get_queue_metrics_snapshot()
    assert "activity_slots_available" not in snapshot
    assert "observed_task_capacity" not in snapshot


async def run_all_tests():
    print("health-server blackbox tests:")
    r = BlackboxResult()
    r.record("health_endpoint", test_health_endpoint)
    r.record("metrics_endpoint", test_metrics_endpoint)
    r.record("set_queue_metrics", test_set_queue_metrics)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
