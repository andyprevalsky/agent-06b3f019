"""Enrich domain service - business logic orchestration.

Coordinates the enrichment workflow: create task, poll status, get results.
Yields ToolEvent progress updates throughout the process.
"""

import time
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message

from .config import (
    DEFAULT_COST_CENTS,
    INITIAL_POLL_INTERVAL_SECS,
    MAX_ENTITY_NAME_LENGTH,
    MAX_POLL_INTERVAL_SECS,
    MAX_POLL_TIME_SECS,
    POLL_BACKOFF_FACTOR,
    PROCESSOR_COSTS_CENTS,
    PROGRESS_UPDATE_INTERVAL_SECS,
    TRUNCATED_LENGTH,
    TRUNCATED_SUFFIX,
)
from .repo import (
    enrich_create_task_activity,
    enrich_get_task_results_activity,
    enrich_poll_status_once_activity,
)

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _build_title_entity(input_data: Dict[str, Any]) -> str:
    """Build a display-friendly entity name from input data."""
    entity_name = (
        input_data.get("name")
        or input_data.get("email")
        or input_data.get("company")
        or input_data.get("url")
        or "entity"
    )
    name_str = str(entity_name)
    if len(name_str) <= MAX_ENTITY_NAME_LENGTH:
        return name_str
    return name_str[:TRUNCATED_LENGTH] + TRUNCATED_SUFFIX


def _build_display_input(input_data: Dict[str, Any]) -> str:
    """Build a human-readable summary of input data."""
    input_summary = []
    if input_data.get("name"):
        input_summary.append(f"Name: {input_data['name']}")
    if input_data.get("email"):
        input_summary.append(f"Email: {input_data['email']}")
    if input_data.get("company"):
        input_summary.append(f"Company: {input_data['company']}")
    if input_data.get("url"):
        input_summary.append(f"URL: {input_data['url']}")
    return "\n".join(input_summary) if input_summary else "Entity data provided"


def _resolve_processor(processor: Any) -> str:
    """Resolve processor to a string, handling enum types."""
    if hasattr(processor, "value"):
        return processor.value
    return str(processor)


def _calculate_cost_cents(processor: str) -> float:
    """Calculate cost in cents based on processor tier."""
    return PROCESSOR_COSTS_CENTS.get(processor.lower(), DEFAULT_COST_CENTS)


async def execute_enrichment(
    tool_call: Dict[str, Any],
) -> AsyncGenerator[ToolEvent, None]:
    """Execute enrichment workflow and yield progress events.

    Orchestrates: create task -> poll status -> get results.
    Yields ToolEvent updates at each stage for UI progress tracking.

    Args:
        tool_call: Tool call dict with 'input', 'output_schema', 'processor'

    Yields:
        ToolEvent updates for progress, completion, or error
    """
    input_data = tool_call.get("input", {})
    output_schema = tool_call.get("output_schema", {})
    processor = _resolve_processor(tool_call.get("processor", "lite"))

    title_entity = _build_title_entity(input_data)
    display_input = _build_display_input(input_data)
    start_time = _safe_time()
    current_progress = 0

    # 1. Pre-execution status (0%)
    yield ToolEvent(
        type=EventType.POST_MESSAGE,
        title=f"\U0001f52c Enriching {title_entity}",
        message=f"{display_input}\nProcessor: {processor}\nExtracting additional data...",
        status=MessageStatus.IN_PROGRESS,
        metadata={"progressComplete": 0},
    )

    try:
        logger.info("Starting enrich workflow", input_keys=list(input_data.keys()), processor=processor)

        # Step 1: Create Task (0% -> 30%)
        create_result = await workflow.execute_activity(
            enrich_create_task_activity,
            args=[input_data, output_schema, processor],
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                backoff_coefficient=2.0,
                initial_interval=timedelta(seconds=1),
                maximum_interval=timedelta(seconds=10),
            ),
        )

        current_progress = 30
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\U0001f52c Enriching {title_entity}",
            message="Task created, enriching data...",
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": current_progress},
        )

        run_id = create_result.get("run_id")

        # Step 2: Poll with time-based progress (30% -> 80%)
        poll_start_time = _safe_time()
        poll_interval = INITIAL_POLL_INTERVAL_SECS
        last_progress_update = poll_start_time

        while True:
            elapsed_poll_time = _safe_time() - poll_start_time
            if elapsed_poll_time >= MAX_POLL_TIME_SECS:
                msg = f"Enrichment task timed out after {MAX_POLL_TIME_SECS} seconds"
                raise TimeoutError(msg)

            await workflow.sleep(poll_interval)

            poll_result = await workflow.execute_activity(
                enrich_poll_status_once_activity,
                args=[run_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=5),
                ),
            )

            is_completed = poll_result.get("is_completed", False)
            is_failed = poll_result.get("is_failed", False)
            warnings = poll_result.get("warnings")

            if is_failed:
                error_msg = warnings or "Unknown error"
                msg = f"Enrichment task failed: {error_msg}"
                raise ValueError(msg)

            if is_completed:
                current_progress = 80
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"\U0001f52c Enriching {title_entity}",
                    message="Enrichment completed! Retrieving results...",
                    status=MessageStatus.IN_PROGRESS,
                    metadata={"progressComplete": current_progress},
                )
                break

            # Time-based progress estimation: 30% -> 80% (50% range)
            time_since_last_update = _safe_time() - last_progress_update
            if time_since_last_update >= PROGRESS_UPDATE_INTERVAL_SECS:
                progress_range = 50  # 30% to 80%
                time_progress = min(1.0, elapsed_poll_time / MAX_POLL_TIME_SECS)
                current_progress = min(80, 30 + int(time_progress * progress_range))
                last_progress_update = _safe_time()

                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"\U0001f52c Enriching {title_entity}",
                    message=f"Enriching... ({int(elapsed_poll_time)}s elapsed)",
                    status=MessageStatus.IN_PROGRESS,
                    metadata={"progressComplete": current_progress},
                )

            poll_interval = min(poll_interval * POLL_BACKOFF_FACTOR, MAX_POLL_INTERVAL_SECS)

        # Step 3: Get Results (80% -> 100%)
        current_progress = 90
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\U0001f52c Enriching {title_entity}",
            message="Fetching enriched data...",
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": current_progress},
        )

        results_data = await workflow.execute_activity(
            enrich_get_task_results_activity,
            args=[run_id],
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=RetryPolicy(
                maximum_attempts=3,
                backoff_coefficient=2.0,
                initial_interval=timedelta(seconds=1),
                maximum_interval=timedelta(seconds=10),
            ),
        )

        output = results_data.get("output", {})
        run_info = results_data.get("run", {})
        usage = results_data.get("usage")

        elapsed_time = _safe_time() - start_time
        total_cost_cents = _calculate_cost_cents(processor)

        # Build standardized usage for workflow cost tracking
        tool_usage = {
            "llm": [],
            "service": [{"cost_cents": int(total_cost_cents), "provider": f"Parallel Task API ({processor})"}],
        }

        result = {"run_id": run_id, "output": output, "run": run_info, "usage": usage}
        message = format_tool_message(
            params=tool_call, result=result, time_elapsed=elapsed_time, cost_cents=total_cost_cents
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Enrichment completed: {title_entity}",
            message=message,
            status=MessageStatus.FINISHED,
            data={"usage": tool_usage},
        )

    except Exception as e:
        elapsed_time = _safe_time() - start_time
        error_message = format_error_message(params=tool_call, error=e, time_elapsed=elapsed_time, cost_cents=0)

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\u274c Enrichment failed: {title_entity}",
            message=error_message,
            status=MessageStatus.ERROR,
            metadata={"progressComplete": current_progress},
        )
