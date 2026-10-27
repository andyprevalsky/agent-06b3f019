#!/usr/bin/env python3
"""Find, and optionally terminate, abandoned dev/benchmark workflows in a namespace.

A dev or benchmark stack polls a private task queue. When the stack stops, its
Running workflows stay Running forever: nothing polls the queue again. On
2026-10-27 the production namespace held 4,094 of them on 1,636 such queues.

A queue's workflows are abandoned only when ALL of these hold:
  * the queue is not a production queue (navi-agent-tasks[@gen], worker pools);
  * two observations, --recheck-seconds apart, both see zero workflow and zero
    activity pollers (no live worker);
  * its newest Running workflow started more than --min-idle-hours ago
    (default 48 h), so no controller is still launching work there.
Everything else is reported and left alone. Dry run by default; --execute
terminates the selected workflows and writes a JSON receipt.

    agents/venv/bin/python scripts/temporal-orphan-sweep.py [--env-file agents/.env] [--execute]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agents"))


def is_production_task_queue(task_queue: str) -> bool:
    from temporal_connection import is_production_task_queue as production

    return production(task_queue)


TERMINATE_REASON = "S18 orphan sweep: dev/benchmark task queue has no worker and no new work"


@dataclass
class QueueObservation:
    task_queue: str
    workflows: list[tuple[str, str]] = field(default_factory=list)  # (workflow_id, run_id)
    newest_start: datetime | None = None
    pollers: list[int] = field(default_factory=list)  # one total per observation


def abandoned(queue: QueueObservation, now: datetime, min_idle: timedelta) -> tuple[bool, str]:
    """Return whether every Running workflow on this queue is provably abandoned."""
    if is_production_task_queue(queue.task_queue):
        return False, "production queue"
    if len(queue.pollers) < 2:
        return False, "fewer than two poller observations"
    if any(count != 0 for count in queue.pollers):
        return False, "live pollers"
    if queue.newest_start is None or now - queue.newest_start < min_idle:
        return False, "recent workflow start"
    return True, "no pollers and no new work"


async def observe(client, recheck_seconds: float) -> dict[str, QueueObservation]:
    from temporalio.api.enums.v1 import TaskQueueType
    from temporalio.api.taskqueue.v1 import TaskQueue
    from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest

    queues: dict[str, QueueObservation] = {}
    async for wf in client.list_workflows("ExecutionStatus='Running'", page_size=1000):
        queue = queues.setdefault(wf.task_queue, QueueObservation(wf.task_queue))
        queue.workflows.append((wf.id, wf.run_id))
        if queue.newest_start is None or wf.start_time > queue.newest_start:
            queue.newest_start = wf.start_time

    limit = asyncio.Semaphore(20)

    async def pollers(name: str) -> int:
        async with limit:
            total = 0
            for kind in (TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW, TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY):
                response = await client.workflow_service.describe_task_queue(
                    DescribeTaskQueueRequest(
                        namespace=client.namespace, task_queue=TaskQueue(name=name), task_queue_type=kind
                    )
                )
                total += len(response.pollers)
            return total

    for attempt in range(2):
        if attempt:
            await asyncio.sleep(recheck_seconds)
        names = [name for name in queues if not is_production_task_queue(name)]
        counts = await asyncio.gather(*(pollers(name) for name in names), return_exceptions=True)
        for name, count in zip(names, counts):
            # A failed read is not evidence of absence: record it as live.
            queues[name].pollers.append(count if isinstance(count, int) else -1)
    return queues


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env-file", default=str(ROOT / "agents" / ".env"))
    parser.add_argument("--min-idle-hours", type=float, default=48.0)
    parser.add_argument("--recheck-seconds", type=float, default=120.0)
    parser.add_argument("--execute", action="store_true", help="terminate the abandoned workflows")
    parser.add_argument("--receipt", default=None, help="JSON receipt path")
    args = parser.parse_args()

    from dotenv import dotenv_values
    from temporalio.client import Client

    from temporal_connection import temporal_connect_options

    env = dotenv_values(args.env_file)
    address, namespace, api_key = env["TEMPORAL_ADDRESS"], env["TEMPORAL_NAMESPACE"], env.get("TEMPORAL_API_KEY", "")
    client = await Client.connect(address, **temporal_connect_options(address, namespace, api_key))
    now = datetime.now(timezone.utc)
    queues = await observe(client, args.recheck_seconds)
    selected, kept = [], []
    for queue in sorted(queues.values(), key=lambda q: -len(q.workflows)):
        ok, why = abandoned(queue, now, timedelta(hours=args.min_idle_hours))
        row = {
            "task_queue": queue.task_queue,
            "workflows": len(queue.workflows),
            "pollers": queue.pollers,
            "newest_start": queue.newest_start.isoformat() if queue.newest_start else None,
            "reason": why,
        }
        (selected if ok else kept).append((queue, row))

    terminated, failed = 0, []
    if args.execute:
        for queue, _row in selected:
            for workflow_id, run_id in queue.workflows:
                try:
                    await client.get_workflow_handle(workflow_id, run_id=run_id).terminate(reason=TERMINATE_REASON)
                    terminated += 1
                except Exception as error:  # already closed or not found: record, continue
                    failed.append({"workflow_id": workflow_id, "run_id": run_id, "error": str(error)[:200]})

    receipt = {
        "observed_at": now.isoformat(),
        "namespace": namespace,
        "executed": args.execute,
        "min_idle_hours": args.min_idle_hours,
        "abandoned_queues": len(selected),
        "abandoned_workflows": sum(len(q.workflows) for q, _ in selected),
        "terminated": terminated,
        "terminate_failures": failed,
        "kept": [row for _, row in kept],
        "abandoned": [row for _, row in selected],
    }
    if args.receipt:
        Path(args.receipt).write_text(json.dumps(receipt, indent=1))
    print(
        f"{namespace}: {receipt['abandoned_workflows']} abandoned workflow(s) on {len(selected)} queue(s); "
        f"kept {sum(r['workflows'] for r in receipt['kept'])} on {len(kept)} queue(s); "
        f"{'terminated ' + str(terminated) if args.execute else 'dry run'}; {len(failed)} failure(s)"
    )
    for row in receipt["kept"]:
        print(f"  kept {row['task_queue']} ({row['workflows']}): {row['reason']}, pollers={row['pollers']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
