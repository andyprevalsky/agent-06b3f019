"""Fail-closed activation gate for a newly deployed Temporal worker build."""

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any

from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

WORKER_DEPLOYMENT_ACTIVATION_PREFIX = "navi-worker-deployment-activation:"
_BUILD_ID_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def worker_deployment_activation_id(build_id: str) -> str:
    """Return the exact build-scoped Temporal activation marker workflow ID."""
    if _BUILD_ID_PATTERN.fullmatch(build_id) is None:
        raise ValueError("Temporal worker build ID must be a lowercase 40-character Git SHA")
    return f"{WORKER_DEPLOYMENT_ACTIVATION_PREFIX}{build_id}"


async def wait_for_worker_build_activation(
    client: Any,
    build_id: str,
    *,
    timeout_seconds: float = 1800.0,
    poll_interval_seconds: float = 1.0,
    monotonic: Callable[[], float] | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> str:
    """Wait until the matching open marker exists; never accept a different/closed build."""
    if timeout_seconds <= 0 or poll_interval_seconds <= 0:
        raise ValueError("Worker activation timing must be positive")
    marker_id = worker_deployment_activation_id(build_id)
    clock = monotonic or asyncio.get_running_loop().time
    wait = sleep or asyncio.sleep
    deadline = clock() + timeout_seconds

    while True:
        try:
            description = await client.get_workflow_handle(marker_id).describe()
            if description.status != WorkflowExecutionStatus.RUNNING:
                raise RuntimeError(
                    f"Temporal worker activation marker {marker_id} is {description.status.name}"
                )
            return marker_id
        except RPCError as error:
            if error.status != RPCStatusCode.NOT_FOUND:
                raise

        if clock() >= deadline:
            raise TimeoutError(f"Temporal worker build {build_id} was not activated within {timeout_seconds:g}s")
        await wait(poll_interval_seconds)
