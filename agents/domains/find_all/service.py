"""Find All domain service — business logic orchestration."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any, AsyncGenerator

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.find_all.config import (
    DEFAULT_GENERATOR,
    GENERATOR_PRICING,
    INITIAL_POLL_INTERVAL,
    MAX_POLL_INTERVAL,
    MAX_POLL_SECONDS,
    OBJECTIVE_PREVIEW_MAX_LEN,
    POLL_BACKOFF_FACTOR,
    TITLE_OBJECTIVE_MAX_LEN,
    TITLE_PREFIXES_TO_STRIP,
)
from domains.find_all.repo import (
    find_all_create_run_activity,
    find_all_get_results_activity,
    find_all_ingest_activity,
    find_all_poll_status_once_activity,
)
from tools.base import (
    EventType,
    MessageStatus,
    ToolEvent,
    ToolManager,
    format_error_message,
    format_tool_message,
)

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time; returns 0 inside the Temporal workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _build_title_objective(objective: str) -> str:
    """Shorten an objective string for use in progress-event titles."""
    title = objective
    for prefix in TITLE_PREFIXES_TO_STRIP:
        if title.lower().startswith(prefix):
            title = title[len(prefix) :]
            break
    if title:
        title = title[0].upper() + title[1:]
    if len(title) > TITLE_OBJECTIVE_MAX_LEN:
        title = title[: TITLE_OBJECTIVE_MAX_LEN - 3] + "..."
    return title


def _truncate_objective(objective: str) -> str:
    """Truncate objective for display in progress messages."""
    if len(objective) <= OBJECTIVE_PREVIEW_MAX_LEN:
        return objective
    return objective[: OBJECTIVE_PREVIEW_MAX_LEN - 3] + "..."


_SHORT_RETRY = RetryPolicy(
    maximum_attempts=3,
    backoff_coefficient=2.0,
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=10),
)
_POLL_RETRY = RetryPolicy(
    maximum_attempts=3,
    backoff_coefficient=2.0,
    initial_interval=timedelta(seconds=1),
    maximum_interval=timedelta(seconds=5),
)


class FindAllManager(ToolManager):
    """Manager for Find All operations using Parallel AI's FindAll API."""

    tool_name = "find_all"
    read_only = True

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute a FindAll search, yielding progress events throughout."""
        objective = tool_call.get("objective", "")
        generator = tool_call.get("generator", DEFAULT_GENERATOR)
        if hasattr(generator, "value"):
            generator = generator.value
        match_limit = tool_call.get("match_limit", 10)

        # Validate preview-generator limit
        if generator.lower() == "preview" and match_limit > 10:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid Find All parameters",
                message=format_error_message(
                    params=tool_call,
                    error=ValueError(
                        "Match limit must be 10 or less for 'preview' generator. "
                        "Preview is designed for testing queries with ~10 candidates. "
                        "Use 'base', 'core', or 'pro' generators for more results."
                    ),
                    time_elapsed=0,
                    cost_cents=0,
                ),
                status=MessageStatus.ERROR,
            )
            return

        title_objective = _build_title_objective(objective)
        start_time = _safe_time()
        current_progress = 0

        # 1. Pre-execution status (0 %)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🔍 Finding All {title_objective}",
            message=f"Objective: {_truncate_objective(objective)}\nGenerator: {generator}\nMatch limit: {match_limit}",
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": 0},
        )

        try:
            logger.info(
                "Starting find_all workflow",
                objective_len=len(objective),
                generator=generator,
                match_limit=match_limit,
            )

            # Step 1: Ingest (0 % -> 20 %)
            ingest_result = await workflow.execute_activity(
                find_all_ingest_activity,
                args=[objective],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=_SHORT_RETRY,
            )

            current_progress = 20
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔍 Finding All {title_objective}",
                message="Objective ingested, creating search run...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress},
            )

            entity_type = ingest_result.get("entity_type")
            match_conditions = ingest_result.get("match_conditions")

            # Step 2: Create run (20 % -> 40 %)
            create_result = await workflow.execute_activity(
                find_all_create_run_activity,
                args=[objective, entity_type, match_conditions, generator, match_limit],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=_SHORT_RETRY,
            )

            current_progress = 40
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔍 Finding All {title_objective}",
                message="Search run created, generating candidates...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress},
            )

            findall_id = create_result.get("findall_id")

            # Step 3: Poll with metrics-based progress (40 % -> 95 %)
            prev_generated_count = 0
            prev_matched_count = 0
            poll_start_time = _safe_time()
            poll_interval = INITIAL_POLL_INTERVAL
            final_status: dict[str, Any] | None = None

            while True:
                elapsed_poll_time = _safe_time() - poll_start_time
                if elapsed_poll_time >= MAX_POLL_SECONDS:
                    raise TimeoutError(f"Find All run timed out after {MAX_POLL_SECONDS} seconds")

                await workflow.sleep(poll_interval)

                poll_result = await workflow.execute_activity(
                    find_all_poll_status_once_activity,
                    args=[findall_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=_POLL_RETRY,
                )

                is_completed = poll_result.get("is_completed", False)
                is_failed = poll_result.get("is_failed", False)
                generated_count = poll_result.get("generated_candidates_count", 0)
                matched_count = poll_result.get("matched_candidates_count", 0)
                final_status = poll_result.get("status", {})

                if is_failed:
                    error_msg = (final_status or {}).get("message", "Unknown error")
                    raise ValueError(f"Find All run failed: {error_msg}")

                if is_completed:
                    current_progress = 95
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔍 Finding All {title_objective}",
                        message=f"Search completed! Found {matched_count} matches. Retrieving results...",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress},
                    )
                    break

                generated_delta = generated_count - prev_generated_count
                matched_delta = matched_count - prev_matched_count

                if generated_delta > 0 or matched_delta > 0:
                    if generated_delta > 0:
                        current_progress = min(70, current_progress + 3)
                    if matched_delta > 0:
                        current_progress = min(95, current_progress + 3)

                    prev_generated_count = generated_count
                    prev_matched_count = matched_count

                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔍 Finding All {title_objective}",
                        message=f"Generated: {generated_count} | Matched: {matched_count}",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress},
                    )

                poll_interval = min(poll_interval * POLL_BACKOFF_FACTOR, MAX_POLL_INTERVAL)

            # Step 4: Get results (95 % -> 100 %)
            results_data = await workflow.execute_activity(
                find_all_get_results_activity,
                args=[findall_id],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=_SHORT_RETRY,
            )

            candidates = results_data.get("candidates", [])
            usage = results_data.get("usage")
            elapsed_time = _safe_time() - start_time

            candidate_count = len(candidates)
            pricing = GENERATOR_PRICING.get(generator.lower(), GENERATOR_PRICING[DEFAULT_GENERATOR])
            total_cost_cents = pricing["fixed"] + (pricing["per_match"] * candidate_count)

            tool_usage = {
                "llm": [],
                "service": [{"cost_cents": int(total_cost_cents), "provider": f"Parallel Find All ({generator})"}],
            }

            result = {
                "findall_id": findall_id,
                "candidates": candidates,
                "status": final_status,
                "usage": usage,
            }

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents,
            )

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Find All completed: {title_objective}",
                message=message,
                status=MessageStatus.FINISHED,
                data={"usage": tool_usage},
            )

        except Exception as e:
            elapsed_time = _safe_time() - start_time
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ Find All failed: {title_objective}",
                message=error_message,
                status=MessageStatus.ERROR,
                metadata={"progressComplete": current_progress},
            )
