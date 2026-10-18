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
    assert data["worker"] == "starting"

    set_worker_status(True)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "healthy"
    assert data["worker"] == "running"

    set_worker_status(True, phase="standby", build_id="a" * 40)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["worker"] == "standby"
    assert data["build_id"] == "a" * 40
    metrics = client.get("/metrics").get_data(as_text=True)
    assert "worker_polling 0" in metrics

    set_worker_status(True, phase="running", build_id="a" * 40)
    metrics = client.get("/metrics").get_data(as_text=True)
    assert "worker_polling 1" in metrics

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


def test_unobserved_queue_metrics_are_unknown_not_zero():
    """A follower or a throttled observer must publish an unknown backlog, never 0.

    A 0 backlog is a scale-down signal; publishing it for a queue nobody observed
    lets dashboards and trace metadata report an idle queue that may be saturated.
    """
    from health_server import (
        app,
        get_queue_metrics_snapshot,
        set_queue_metrics,
        set_queue_observation,
    )

    set_queue_observation(None, None, desired_machines=8, current_machines=25)
    text = app.test_client().get("/metrics").get_data(as_text=True)
    assert "task_queue_backlog NaN" in text, text
    assert "running_workflow_count NaN" in text, text
    assert "task_queue_metrics_present 0" in text, text
    assert "task_queue_metrics_age_seconds NaN" in text, text
    assert "desired_machine_count 8" in text, text
    snapshot = get_queue_metrics_snapshot()
    assert "task_queue_backlog" not in snapshot, snapshot
    assert "running_workflow_count" not in snapshot, snapshot

    set_queue_observation(0, 3, desired_machines=8, current_machines=25, age_seconds=2.0, source="leader")
    text = app.test_client().get("/metrics").get_data(as_text=True)
    assert "task_queue_backlog 0" in text, text
    assert "task_queue_metrics_present 1" in text, text
    snapshot = get_queue_metrics_snapshot()
    assert snapshot["task_queue_backlog"] == 0 and snapshot["running_workflow_count"] == 3, snapshot
    assert snapshot["task_queue_metrics_source"] == "leader", snapshot
    assert snapshot["task_queue_metrics_age_seconds"] >= 2.0, snapshot

    set_queue_metrics(0, 0, 2, 1)


def test_autoscaler_peer_view_reports_identity_liveness_and_local_readings():
    """Peers elect the observing leader from this view; it must not need Temporal."""
    import os

    import health_server
    from health_server import (
        app,
        set_autoscaler_role,
        set_local_autoscaler_metrics,
        set_queue_metrics,
        set_queue_observation,
    )

    saved = os.environ.get("TEMPORAL_WORKER_SURFACE_HASH")
    os.environ["TEMPORAL_WORKER_SURFACE_HASH"] = "gen-a"
    try:
        set_queue_observation(None, None, desired_machines=2, current_machines=1)
        set_autoscaler_role("follower", leader_eligible=False, observes_queue=False)
        view = app.test_client().get("/autoscaler/peer").get_json()
        assert view["surface_hash"] == "gen-a", view
        assert view["leader_eligible"] is False, view
        assert view["queue"] is None, view

        set_local_autoscaler_metrics(
            machine_memory_used_percent=63.5,
            activity_slots_used=4,
            activity_slots_available=246,
            activity_admission_open=False,
            activity_admission_memory_percent=63.5,
        )
        set_autoscaler_role("leader", leader_eligible=True, observes_queue=True)
        set_queue_observation(12, 30, desired_machines=10, current_machines=9)
        view = app.test_client().get("/autoscaler/peer").get_json()
        assert view["role"] == "leader" and view["leader_eligible"] is True, view
        assert 0 <= view["heartbeat_age_seconds"] < 5, view
        assert view["machine_memory_used_percent"] == 63.5, view
        assert view["activity_admission_open"] is False and view["activity_slots_used"] == 4, view
        assert view["queue"]["backlog"] == 12 and view["queue"]["workflow_count"] == 30, view
        assert view["queue"]["desired_machines"] == 10 and view["queue"]["source"] == "self", view

        # A mirrored (leader-sourced) observation is never re-advertised as this
        # worker's own, so a stale copy cannot propagate down a follower chain.
        set_queue_observation(12, 30, desired_machines=10, current_machines=9, source="leader")
        assert app.test_client().get("/autoscaler/peer").get_json()["queue"] is None

        metrics = app.test_client().get("/metrics").get_data(as_text=True)
        assert "autoscaler_is_leader 1" in metrics, metrics
        assert "autoscaler_observes_queue 1" in metrics, metrics
        assert "autoscaler_leadership_known 1" in metrics, metrics
        set_autoscaler_role("unknown", leader_eligible=True, observes_queue=True)
        metrics = app.test_client().get("/metrics").get_data(as_text=True)
        assert "autoscaler_is_leader 0" in metrics and "autoscaler_leadership_known 0" in metrics, metrics
        assert health_server.get_queue_metrics_snapshot()["autoscaler_role"] == "unknown"
    finally:
        if saved is None:
            os.environ.pop("TEMPORAL_WORKER_SURFACE_HASH", None)
        else:
            os.environ["TEMPORAL_WORKER_SURFACE_HASH"] = saved
        set_autoscaler_role(None, leader_eligible=False, observes_queue=False)
        set_queue_metrics(0, 0, 2, 1)


async def run_all_tests():
    print("health-server blackbox tests:")
    r = BlackboxResult()
    r.record("health_endpoint", test_health_endpoint)
    r.record("metrics_endpoint", test_metrics_endpoint)
    r.record("set_queue_metrics", test_set_queue_metrics)
    r.record("unobserved_queue_metrics_are_unknown", test_unobserved_queue_metrics_are_unknown_not_zero)
    r.record("autoscaler_peer_view", test_autoscaler_peer_view_reports_identity_liveness_and_local_readings)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
