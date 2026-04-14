"""Read-message-history handler (runtime layer).

Thin entry point: parse input -> call service -> return output.
Imports: own service, own types, own config, providers.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Optional

import httpx
import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from domains.read_message_history.config import (
    ACTIVITY_TIMEOUT_SECONDS,
    MAX_RETRY_ATTEMPTS,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_INITIAL_INTERVAL_SECONDS,
    RETRY_MAX_INTERVAL_SECONDS,
    TOOL_NAME,
)
from domains.read_message_history.service import (
    fetch_message_history,
    build_person_identifier,
    build_read_metadata,
    post_error_event,
    post_in_progress,
    post_result_event,
    post_validation_error,
    validate_identifiers,
)

# ReadMessageHistoryResult must be available at runtime because Temporal's
# @activity.defn calls get_type_hints() on the decorated function.
from domains.read_message_history.types import ReadMessageHistoryResult  # noqa: TCH001
from tools.base import ToolManager, extract_root_error

if TYPE_CHECKING:
    from domains.read_message_history.types import ExecuteActivityCallable

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class ReadMessageHistoryManager(ToolManager):
    """Manager for reading message history with a person."""

    tool_name = TOOL_NAME
    read_only = True  # Research phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Execute message history read and post events via handle_tool_event."""
        phone = tool_call.get("phone")
        email = tool_call.get("email")
        first_name = tool_call.get("first_name")
        last_name = tool_call.get("last_name")

        start_time = _safe_time()

        # Validate at least one identifier is provided
        if not validate_identifiers(phone=phone, email=email, first_name=first_name, last_name=last_name):
            await post_validation_error(
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": "Missing identifier", "messages": [], "person": None}

        person_identifier = build_person_identifier(
            phone=phone, email=email, first_name=first_name, last_name=last_name
        )

        # 1. Pre-execution status
        await post_in_progress(
            person_identifier=person_identifier,
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute activity
        try:
            result = await execute_activity(
                read_message_history_activity,
                args=[user_id, phone, email, first_name, last_name],
                start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=MAX_RETRY_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = _safe_time() - start_time

            read_metadata = build_read_metadata(
                phone=phone,
                email=email,
                first_name=first_name,
                last_name=last_name,
                person=result.get("person"),
            )

            # 3. Post result event
            await post_result_event(
                result=result,
                tool_call=tool_call,
                elapsed_time=elapsed_time,
                read_metadata=read_metadata,
                person_identifier=person_identifier,
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return result

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            await post_error_event(
                error=e,
                tool_call=tool_call,
                elapsed_time=elapsed_time,
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {"error": extract_root_error(e), "messages": [], "person": None}


# ========================================
# SINGLETON
# ========================================

_manager: ReadMessageHistoryManager | None = None


def get_manager() -> ReadMessageHistoryManager:
    """Get or create read message history manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = ReadMessageHistoryManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================


async def read_message_history_with_person(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """Execute read_message_history_with_person tool."""
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


# ========================================
# TEMPORAL ACTIVITY
# ========================================


@activity.defn
async def read_message_history_activity(
    user_id: str,
    phone: Optional[str] = None,
    email: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    message_limit: int = 50,
) -> ReadMessageHistoryResult:
    """Activity: Read message history via backend API."""
    try:
        activity.heartbeat("Reading message history...")

        return await fetch_message_history(
            user_id=user_id,
            phone=phone,
            email=email,
            first_name=first_name,
            last_name=last_name,
            message_limit=message_limit,
        )

    except httpx.TimeoutException as e:
        logger.error("Read message history timeout")
        raise Exception("Request timed out while reading message history") from e
    except Exception as e:
        logger.error("Read message history failed", error=str(e))
        raise
