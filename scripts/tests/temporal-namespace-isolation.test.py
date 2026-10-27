#!/usr/bin/env python3
"""Dev and benchmark stacks stay out of the production Temporal namespace (S18).

Covers the run.sh routing helper (stack_bench_temporal_exports), the shared
production-queue predicate, the worker's start-up refusal, and the orphan
sweep's abandonment rule. Offline: the worker refuses before any connection.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents"))

PROD = "rose-labs-us-east-1.tch2n"
BENCH = "rose-labs-bench.tch2n"
CLEAN_ENV = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith(("TEMPORAL_", "CLOUDBENCH_GUEST_TEMPORAL"))
}


def routed(agents_env: Path, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", '. scripts/lib/cloudbench-env.sh && stack_bench_temporal_exports "$1"', "_", str(agents_env)],
        cwd=ROOT,
        env={**CLEAN_ENV, **(extra or {})},
        capture_output=True,
        text=True,
        check=False,
    )


def write(path: Path, body: str, mode: int = 0o600) -> Path:
    path.write_text(body)
    path.chmod(mode)
    return path


def test_routing_helper() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        agents_env = write(root / ".env", f"TEMPORAL_ADDRESS=cloud.example:7233\nTEMPORAL_NAMESPACE={PROD}\nTEMPORAL_API_KEY=prod-key\n")

        missing = routed(agents_env)
        assert missing.returncode != 0 and "production Temporal namespace" in missing.stderr, missing

        write(
            root / ".env.benchmark-temporal",
            "# managed\nCLOUDBENCH_GUEST_TEMPORAL_ADDRESS=bench.example:7233\n"
            f"CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE={BENCH}\nCLOUDBENCH_GUEST_TEMPORAL_API_KEY=bench-key\n",
        )
        moved = routed(agents_env)
        assert moved.returncode == 0, moved.stderr
        assert moved.stdout.split() == [
            "export",
            "TEMPORAL_ADDRESS=bench.example:7233",
            "export",
            f"TEMPORAL_NAMESPACE={BENCH}",
            "export",
            "TEMPORAL_API_KEY=bench-key",
        ], moved.stdout

        assert routed(agents_env, {"TEMPORAL_ADDRESS": "localhost:7233"}).stdout == ""
        assert routed(agents_env, {"TEMPORAL_NAMESPACE": "someone-else.ns"}).stdout == ""

        write(root / ".env.benchmark-temporal", (root / ".env.benchmark-temporal").read_text(), 0o644)
        loose = routed(agents_env)
        assert loose.returncode != 0 and "0600" in loose.stderr, loose

        write(
            root / ".env.benchmark-temporal",
            "CLOUDBENCH_GUEST_TEMPORAL_ADDRESS=bench.example:7233\n"
            f"CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE={PROD}\nCLOUDBENCH_GUEST_TEMPORAL_API_KEY=k\n",
        )
        same = routed(agents_env)
        assert same.returncode != 0 and "production Temporal namespace" in same.stderr, same


def test_run_sh_applies_routing() -> None:
    source = (ROOT / "scripts" / "run.sh").read_text()
    queue = source.index('TEMPORAL_TASK_QUEUE="$(resolve_temporal_task_queue')
    route = source.index("stack_bench_temporal_exports agents/.env")
    services = source.index("Ensuring DEMO cache schema")
    assert queue < route < services, "run.sh must route the stack's namespace before starting services"


def test_stack_queue_consumers_route_namespace() -> None:
    # Every helper that reaches a stack's private queue must use the stack's
    # namespace, or stale-workflow cleanup silently looks in production's.
    cleanup = (ROOT / "agents" / "benchmarks" / "run_benchmark.py").read_text()
    body = cleanup[cleanup.index("async def _terminate_stale_workflows"):]
    body = body[: body.index("\nasync def ", 1) if "\nasync def " in body[1:] else len(body)]
    assert body.index("apply_stack_temporal_namespace()") < body.index("load_config()"), "cleanup must route first"
    local = (ROOT / "agents" / "benchmarks" / "local.py").read_text()
    assert "apply_stack_temporal_namespace(REPO_ROOT)" in local


def test_queue_predicate() -> None:
    from temporal_connection import is_production_task_queue, production_namespace_refusal

    for queue in ("navi-agent-tasks", "navi-agent-tasks@abc123", "navi-agent-tasks-pool-265ecf9120a6@ed23d1ef8e13"):
        assert is_production_task_queue(queue), queue
        assert production_namespace_refusal(PROD, queue) is None
    for queue in ("navi-agent-tasks-cloud-b024f5c1", "navi-agent-tasks-x-bench-1-2-3", "navi-agent-tasks-test"):
        assert not is_production_task_queue(queue), queue
        assert production_namespace_refusal(PROD, queue), queue
        assert production_namespace_refusal(BENCH, queue) is None


def test_worker_refuses_dev_queue_in_production_namespace() -> None:
    python = ROOT / "agents" / "venv" / "bin" / "python"
    result = subprocess.run(
        [str(python if python.exists() else sys.executable), "worker.py"],
        cwd=ROOT / "agents",
        env={
            **CLEAN_ENV,
            "TEMPORAL_ADDRESS": "unreachable.invalid:7233",
            "TEMPORAL_NAMESPACE": PROD,
            "TEMPORAL_API_KEY": "unused",
            "TEMPORAL_TASK_QUEUE": "navi-agent-tasks-s18-regression",
            "ENVIRONMENT": "development",
            "HEALTH_CHECK_PORT": "0",
        },
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output[-2000:]
    assert "Temporal namespace isolation refused worker start" in output, output[-2000:]


def test_sweep_abandonment_rule() -> None:
    spec = importlib.util.spec_from_file_location("sweep", ROOT / "scripts" / "temporal-orphan-sweep.py")
    sweep = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules["sweep"] = sweep
    spec.loader.exec_module(sweep)
    now = datetime(2026, 10, 27, tzinfo=timezone.utc)
    idle = timedelta(hours=48)
    old = now - timedelta(days=5)

    def queue(name: str, pollers: list[int], newest: datetime | None = old):
        return sweep.QueueObservation(name, [("wf", "run")], newest, pollers)

    assert sweep.abandoned(queue("navi-agent-tasks-x-bench-1", [0, 0]), now, idle)[0]
    assert not sweep.abandoned(queue("navi-agent-tasks@abc", [0, 0]), now, idle)[0]
    assert not sweep.abandoned(queue("navi-agent-tasks-x-bench-1", [0, 2]), now, idle)[0]
    assert not sweep.abandoned(queue("navi-agent-tasks-x-bench-1", [0, -1]), now, idle)[0]
    assert not sweep.abandoned(queue("navi-agent-tasks-x-bench-1", [0]), now, idle)[0]
    assert not sweep.abandoned(queue("navi-agent-tasks-x-bench-1", [0, 0], now - timedelta(hours=3)), now, idle)[0]


def main() -> None:
    for test in (
        test_routing_helper,
        test_run_sh_applies_routing,
        test_stack_queue_consumers_route_namespace,
        test_queue_predicate,
        test_worker_refuses_dev_queue_in_production_namespace,
        test_sweep_abandonment_rule,
    ):
        test()
        print(f"ok {test.__name__}")
    print("temporal namespace isolation tests passed")


if __name__ == "__main__":
    main()
