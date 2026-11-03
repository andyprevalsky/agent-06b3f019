"""Finished tool for marking agent task completion."""

import asyncio
from datetime import datetime
from typing import Dict, List, Optional

import httpx
import structlog
from temporalio import activity

from config import load_config
from helpers.workflow_generation import workflow_generation_headers
from utils.utils import extract_goal_from_context

logger = structlog.get_logger()


async def _persist_output_derived_root_title(agent_id: str, structured_response: Dict) -> None:
    """Name an untitled root from its verified output before terminal snapshotting."""
    from providers.demo_cache.rose_cache import meaningful_response_schema_title

    schema = {
        "fields": [
            {"name": name}
            for name in structured_response
            if isinstance(name, str) and name and not name.startswith("_")
        ]
    }
    if not schema["fields"]:
        return
    title = meaningful_response_schema_title(schema)
    config = load_config()
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.patch(
            f"{config.backend.api_url.rstrip('/')}/api/agents/{agent_id}",
            json={"generated_title": title},
            headers={
                "X-API-Key": config.backend.api_key or "",
                "Content-Type": "application/json",
                **workflow_generation_headers(),
            },
        )
        response.raise_for_status()


@activity.defn
async def mark_finished(
    agent_id: str,
    steps_taken: List[Dict],
    token_count: int = 0,
    context_size: int = 0,
    message_count: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    summary: str = "",
    structured_response: Optional[Dict] = None,
    iteration_offset: Optional[int] = None,
    root_agent_id: Optional[str] = None,
) -> Dict:
    """
    Activity: Mark an agent task as finished.

    This updates the agent status to COMPLETED in the database.

    Args:
        agent_id: Agent ID
        steps_taken: Detailed steps taken (first USER message is the goal)
        token_count: Total tokens used
        context_size: Context size in tokens
        message_count: Total messages
        tokens_in: Input tokens (prompt)
        tokens_out: Output tokens (completion)
        summary: Summary of work completed (for sub-agents to return to parent)
        structured_response: Extracted structured output from the agent (if schema was defined)
        root_agent_id: Root run ID used by the shared trace archive bundle

    Returns:
        Dict with completion details including summary
    """
    try:
        activity.heartbeat("Marking task as finished")

        # Extract goal from first USER message
        goal = extract_goal_from_context(steps_taken)

        # Settle archive jobs accepted by this worker process before the status
        # transition asks the backend to snapshot the run. This cannot see jobs
        # owned by another replica, so the backend's durable finalization fence
        # remains the source of truth and reconciles any cross-process late PUT.
        from helpers.trace_archive import flush_archive_writes

        archive_root_agent_id = root_agent_id or agent_id
        try:
            # mark_finished's workflow start_to_close is 30s. A 15s flush left
            # no room for the COMPLETED PATCH under 50-child fan-out, so the
            # activity timed out and a verified agent stayed ACTIVE until the
            # smoke cap (ed9a3b6e, 2026-09-29). 5s settles local jobs and
            # still leaves the status write inside the 30s budget; the
            # backend durable fence reconciles any leftover PUTs.
            archive_settled = await asyncio.to_thread(flush_archive_writes, archive_root_agent_id, 5.0)
        except Exception as exc:
            logger.warning(
                "trace_archive.pre_terminal_flush_error",
                agent_id=agent_id,
                root_agent_id=archive_root_agent_id,
                error=str(exc)[:200],
            )
        else:
            if not archive_settled:
                logger.warning(
                    "trace_archive.pre_terminal_flush_incomplete",
                    agent_id=agent_id,
                    root_agent_id=archive_root_agent_id,
                )

        if archive_root_agent_id == agent_id and isinstance(structured_response, dict):
            try:
                await _persist_output_derived_root_title(agent_id, structured_response)
            except Exception as exc:
                # The output and schema failure remain visible; a title write
                # must not prevent a verified task from reaching COMPLETED.
                logger.warning("Failed to save output-derived root title", agent_id=agent_id, error=str(exc)[:200])

        # Use the single update_agent_status helper (no activity wrapper - call directly)
        from helpers.update_status import _update_agent_status_impl

        await _update_agent_status_impl(
            agent_id=agent_id,
            status="COMPLETED",
            progress=1.0,
            status_message=f"Successfully completed: {goal}",
            token_count=token_count,
            context_size=context_size,
            message_count=message_count,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            structured_response=structured_response,
            iteration_offset=iteration_offset,
        )

        logger.info("Agent status updated to COMPLETED", agent_id=agent_id)

        result = {
            "agent_id": agent_id,
            "goal": goal,
            "steps_count": len(steps_taken),
            "completed_at": datetime.utcnow().isoformat(),
            "summary": summary,  # Include summary for parent signaling
        }

        logger.info("Task marked as finished", agent_id=agent_id, goal=goal[:50], has_summary=bool(summary))

        return result

    except Exception as e:
        logger.error("Failed to mark task as finished", agent_id=agent_id, error=str(e))
        raise
