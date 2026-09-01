"""
Cloud-agent spawn latency ratchet.

Measures POST /api/agents → first "Starting Reasoning" lifecycle title
(proxy for first LLM request start). Cleans up the agent immediately after
measurement. Fails if spawn exceeds SPAWN_BUDGET_S (15s with synchronous
response-schema generation on cache miss).

Run:
  TEST_BASE_URL=http://localhost:3101 \\
  E2E_TASK_QUEUE=navi-agent-tasks-cloud-spawn-ec50 \\
  agents/venv/bin/python -m tests.e2e.test_cloud_agent_spawn_latency
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

# agents/ on sys.path for `tests.e2e.*` imports when run as a module or script.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tests.e2e.test_helpers import (  # noqa: E402
    authenticate,
    cleanup_agent,
    get_agent_status,
    spawn_agent,
)

SPAWN_BUDGET_S = 15.0
STARTING_REASONING_TITLE = "Starting Reasoning"
POLL_INTERVAL_S = 0.1
DEFAULT_TIMEOUT_S = 60.0


def _message_title(message: dict[str, Any]) -> str | None:
    metadata = message.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except Exception:
            return None
    if not isinstance(metadata, dict):
        return None
    title = metadata.get("title")
    return title if isinstance(title, str) else None


async def measure_spawn_to_starting_reasoning(
    *,
    goal: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    task_queue: str | None = None,
) -> dict[str, Any]:
    """Create a cloud agent, time to Starting Reasoning, delete immediately."""
    await authenticate()
    agent_id: str | None = None
    t0 = time.perf_counter()
    try:
        agent_id = await spawn_agent(
            goal=goal,
            start_phase="execute",
            task_queue=task_queue,
        )
        create_ms = (time.perf_counter() - t0) * 1000.0
        deadline = time.time() + timeout_s
        titles_seen: list[str] = []
        while time.time() < deadline:
            status = await get_agent_status(agent_id)
            messages = status.get("messages") or []
            titles = [t for m in messages if (t := _message_title(m))]
            if titles != titles_seen:
                titles_seen = list(titles)
            if STARTING_REASONING_TITLE in titles:
                elapsed_s = time.perf_counter() - t0
                return {
                    "ok": True,
                    "agent_id": agent_id,
                    "elapsed_s": elapsed_s,
                    "create_ms": create_ms,
                    "titles": titles_seen,
                }
            await asyncio.sleep(POLL_INTERVAL_S)

        elapsed_s = time.perf_counter() - t0
        return {
            "ok": False,
            "agent_id": agent_id,
            "elapsed_s": elapsed_s,
            "create_ms": create_ms,
            "titles": titles_seen,
            "error": f"Timed out after {timeout_s:.1f}s waiting for {STARTING_REASONING_TITLE!r}",
        }
    finally:
        if agent_id:
            deleted = await cleanup_agent(agent_id)
            if not deleted:
                print(f"  WARNING: failed to cleanup agent {agent_id}")


async def run_latency_ratchet(
    *,
    samples: int = 3,
    budget_s: float = SPAWN_BUDGET_S,
    task_queue: str | None = None,
) -> int:
    results: list[dict[str, Any]] = []
    for i in range(samples):
        goal = f"Spawn latency probe {i + 1}: reply with exactly PONG and nothing else."
        print(f"\nSample {i + 1}/{samples}: spawning…")
        result = await measure_spawn_to_starting_reasoning(goal=goal, task_queue=task_queue)
        results.append(result)
        status = "PASS" if result.get("ok") and result["elapsed_s"] < budget_s else "FAIL"
        print(
            f"  {status} agent={result.get('agent_id')} "
            f"elapsed={result.get('elapsed_s', 0):.3f}s "
            f"create={result.get('create_ms', 0):.0f}ms "
            f"titles={result.get('titles')}"
        )
        if result.get("error"):
            print(f"  error: {result['error']}")

    elapsed = [r["elapsed_s"] for r in results if r.get("ok")]
    failures = [r for r in results if not r.get("ok") or r["elapsed_s"] >= budget_s]
    print("\n=== cloud-agent spawn latency ratchet ===")
    print(f"budget: {budget_s:.1f}s  samples: {samples}  ok: {len(elapsed)}/{samples}")
    if elapsed:
        print(
            f"elapsed_s: min={min(elapsed):.3f}  "
            f"mean={statistics.mean(elapsed):.3f}  "
            f"max={max(elapsed):.3f}"
        )
    if failures:
        print(f"FAILURES: {len(failures)}")
        return 1
    print(f"ALL SAMPLES < {budget_s:.1f}s")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--budget", type=float, default=SPAWN_BUDGET_S)
    parser.add_argument("--task-queue", default=os.environ.get("E2E_TASK_QUEUE"))
    args = parser.parse_args()
    if not os.environ.get("TEST_BASE_URL"):
        # Local cloud-spawn stack default (see .context/services.json).
        os.environ.setdefault("TEST_BASE_URL", "http://localhost:3101")
    raise SystemExit(
        asyncio.run(
            run_latency_ratchet(
                samples=args.samples,
                budget_s=args.budget,
                task_queue=args.task_queue,
            )
        )
    )


if __name__ == "__main__":
    main()
