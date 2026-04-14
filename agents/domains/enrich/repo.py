"""Enrich domain repo - data access via Parallel AI Task API.

Each function is a Temporal activity that makes HTTP calls to the Parallel AI API.
Typed args in, typed results out.
"""

import contextlib
from typing import Any, Dict, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config

from .config import (
    BASE_URL,
    CREATE_TASK_TIMEOUT,
    GET_RESULTS_TIMEOUT,
    POLL_STATUS_TIMEOUT,
)
from .types import CreateTaskResult, PollStatusResult, TaskResultsData

logger = structlog.get_logger()


def _get_headers() -> dict[str, str]:
    """Build API headers with key from config."""
    config = load_config()
    return {"x-api-key": config.parallel.api_key, "Content-Type": "application/json"}


@activity.defn
async def enrich_create_task_activity(
    input_data: Dict[str, Optional[str]], output_schema: Dict[str, Any], processor: str
) -> CreateTaskResult:
    """Create an enrichment task via Parallel AI Task API.

    Args:
        input_data: Dict with person/company metadata
        output_schema: JSON schema defining what to extract
        processor: Processor type (lite/base/core/pro/ultra)

    Returns:
        CreateTaskResult with run_id of the created task
    """
    try:
        with contextlib.suppress(RuntimeError):
            activity.heartbeat(f"Creating enrichment task: {input_data.get('name', 'Unknown')}")

        headers = _get_headers()
        task_payload = {"input": input_data, "task_spec": {"output_schema": output_schema}, "processor": processor}

        async with httpx.AsyncClient(timeout=CREATE_TASK_TIMEOUT) as client:
            create_response = await client.post(f"{BASE_URL}/v1/tasks/runs", headers=headers, json=task_payload)
            create_response.raise_for_status()
            create_data = create_response.json()

            run_id = create_data.get("run_id")
            if not run_id:
                msg = "No run_id returned from task run creation"
                raise ValueError(msg)

            logger.info("Enrichment task created", run_id=run_id, processor=processor)
            return CreateTaskResult(run_id=run_id)

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich create task error", error=error_msg, input_data=input_data)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich create task failed", error=str(e), input_data=input_data)
        raise


@activity.defn
async def enrich_poll_status_once_activity(run_id: str) -> PollStatusResult:
    """Poll status of an enrichment task once.

    Args:
        run_id: ID of the enrichment task run

    Returns:
        PollStatusResult with status, completion, and failure info
    """
    try:
        with contextlib.suppress(RuntimeError):
            activity.heartbeat(f"Polling enrichment status for {run_id}...")

        headers = _get_headers()

        async with httpx.AsyncClient(timeout=POLL_STATUS_TIMEOUT) as client:
            status_response = await client.get(f"{BASE_URL}/v1/tasks/runs/{run_id}", headers=headers)
            status_response.raise_for_status()
            status_data = status_response.json()

            status_value = status_data.get("status", "unknown")
            is_active = status_data.get("is_active", True)
            warnings = status_data.get("warnings")

            is_completed = status_value == "completed" and not is_active
            is_failed = status_value == "failed"

            logger.info("Enrich status polled", run_id=run_id, status=status_value, is_active=is_active)

            return PollStatusResult(
                status=status_value,
                is_active=is_active,
                is_completed=is_completed,
                is_failed=is_failed,
                warnings=warnings,
            )

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich poll status error", error=error_msg, run_id=run_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich poll status failed", error=str(e), run_id=run_id)
        raise


@activity.defn
async def enrich_get_task_results_activity(run_id: str) -> TaskResultsData:
    """Get results from a completed enrichment task.

    Args:
        run_id: ID of the enrichment task run

    Returns:
        TaskResultsData with output, run info, and usage
    """
    try:
        with contextlib.suppress(RuntimeError):
            activity.heartbeat(f"Retrieving enrichment results for {run_id}...")

        headers = _get_headers()

        async with httpx.AsyncClient(timeout=GET_RESULTS_TIMEOUT) as client:
            result_response = await client.get(f"{BASE_URL}/v1/tasks/runs/{run_id}/result", headers=headers)
            result_response.raise_for_status()
            result_data = result_response.json()

            output = result_data.get("output", {})
            run_info = result_data.get("run", {})

            logger.info("Enrichment results retrieved", run_id=run_id, output_type=output.get("type", "unknown"))

            return TaskResultsData(
                output=output,
                run=run_info,
                usage=None,  # Task API may not return usage in same format
            )

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich get results error", error=error_msg, run_id=run_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich get results failed", error=str(e), run_id=run_id)
        raise
