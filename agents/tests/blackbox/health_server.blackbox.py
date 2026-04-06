"""Blackbox tests for health_server domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


def test_health_endpoint():
    """GET /health returns 200 with status key."""
    from health_server import app

    client = app.test_client()
    response = client.get("/health")

    assert response.status_code == 200
    data = response.get_json()
    assert "status" in data
    assert data["status"] == "healthy"


def test_metrics_endpoint():
    """GET /metrics returns 200 with Prometheus-format text containing temporal_queue_backlog."""
    from health_server import app

    client = app.test_client()
    response = client.get("/metrics")

    assert response.status_code == 200
    text = response.get_data(as_text=True)
    assert "task_queue_backlog" in text
    assert "running_workflow_count" in text


def test_set_queue_metrics():
    """set_queue_metrics updates values that appear in /metrics."""
    from health_server import app, set_queue_metrics

    set_queue_metrics(5, 10, 2, 1)

    client = app.test_client()
    response = client.get("/metrics")
    text = response.get_data(as_text=True)

    assert "task_queue_backlog 5" in text
    assert "running_workflow_count 10" in text
    assert "desired_machine_count 2" in text
    assert "current_machine_count 1" in text

    # Reset to defaults to avoid polluting other tests
    set_queue_metrics(0, 0, 2, 1)


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
