"""Temporal client security options shared by workers and benchmark cleanup."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from temporalio.client import TLSConfig


def is_local_temporal_address(address: str) -> bool:
    """Return whether an address targets a loopback Temporal dev server."""
    normalized = address.strip().lower()
    if normalized == "::1":
        return True
    host = normalized.rsplit(":", 1)[0].strip("[]")
    return host in {"localhost", "127.0.0.1", "::1"}


def temporal_connect_options(address: str, namespace: str, api_key: str) -> dict[str, Any]:
    """Build TLS/auth options for local Temporal or Temporal Cloud."""
    if is_local_temporal_address(address):
        return {"namespace": namespace, "tls": False}
    return {
        "namespace": namespace,
        "tls": TLSConfig(client_cert=None, client_private_key=None),
        "rpc_metadata": {
            "temporal-namespace": namespace,
            "Authorization": f"Bearer {api_key}",
        },
    }


# Production Temporal Cloud namespace. Not a secret (the API key is); committed
# so every host agrees which namespace only production queues may use. Dev and
# benchmark stacks belong in the benchmark namespace (scripts/run.sh routes them
# there): their per-stack queues outlive the stack, and 4,094 such workflows
# were left Running in this namespace on 2026-10-27, sharing production's
# action and Visibility API budgets.
PRODUCTION_TEMPORAL_NAMESPACE = "rose-labs-us-east-1.tch2n"
PRODUCTION_BASE_TASK_QUEUE = "navi-agent-tasks"
_PRODUCTION_POOL_QUEUE = re.compile(r"navi-agent-tasks-pool-[a-f0-9]{12}(@[A-Za-z0-9]+)?")


def is_production_task_queue(task_queue: str) -> bool:
    """Return whether a queue is a production queue (plain, generation or worker pool)."""
    base = task_queue.strip().split("@", 1)[0]
    return base == PRODUCTION_BASE_TASK_QUEUE or bool(_PRODUCTION_POOL_QUEUE.fullmatch(task_queue.strip()))


def production_namespace_refusal(namespace: str, task_queue: str) -> str | None:
    """Explain why a non-production queue must not use the production namespace."""
    if namespace.strip() != PRODUCTION_TEMPORAL_NAMESPACE or is_production_task_queue(task_queue):
        return None
    return (
        f"Refusing Temporal queue {task_queue!r} in the production namespace "
        f"{PRODUCTION_TEMPORAL_NAMESPACE}: dev and benchmark stacks must use the benchmark "
        "namespace. Start the stack with scripts/run.sh (it routes to the namespace in "
        "agents/.env.benchmark-temporal), or export TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/"
        "TEMPORAL_API_KEY for a non-production namespace."
    )


def apply_stack_temporal_namespace(repo_root: Path | None = None) -> None:
    """Point this process at the stack's Temporal namespace, as scripts/run.sh does.

    run.sh moves dev/benchmark stacks onto the benchmark namespace; any helper
    that reaches the stack's queue (stale-workflow cleanup) must look there too.
    """
    root = repo_root or Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["bash", "-c", ". scripts/lib/cloudbench-env.sh && stack_bench_temporal_exports agents/.env"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "stack Temporal namespace routing failed")
    for line in result.stdout.splitlines():
        name, _, value = line.removeprefix("export ").partition("=")
        if name in {"TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY"}:
            os.environ[name] = shlex.split(value)[0] if value else ""
