"""Web fetch domain handler — tool entry point and Temporal activity."""

import time
from datetime import timedelta
from typing import Any, Dict, List, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy

from domains.web_fetch.config import PARALLEL_AI_COST_CENTS
from domains.web_fetch.service import fetch_and_extract
from domains.web_fetch.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from helpers.tracing import traced
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


logger = structlog.get_logger()


def _truncate_display(value: str, max_len: int = 100) -> str:
    if len(value) <= max_len:
        return value
    return value[: max_len - 3] + "..."


def _format_fetch_title(prefix: str, url: str, objective: str) -> str:
    display_url = _truncate_display(url, 80) if url else "URL"
    display_objective = _truncate_display(objective, 70)
    if display_objective:
        return f"{prefix} {display_url} for {display_objective}"
    return f"{prefix} {display_url}"


class WebFetchManager(ToolManager):
    """Manager for web fetch operations using Parallel AI's extract capability."""

    tool_name = "web_fetch"
    read_only = True  # Research phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute web fetch and post events via handle_tool_event."""
        url = tool_call.get("url", "")
        objective = tool_call.get("objective", "")

        start_time = _safe_time()
        display_objective = _truncate_display(objective)
        progress_title = _format_fetch_title("Fetching", url, objective)
        completed_title = _format_fetch_title("Fetched", url, objective)
        failed_title = _format_fetch_title("\u274c Web fetch failed for", url, objective)

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=progress_title,
                message=f"Extracting from {url}: {display_objective}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="web_fetch",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            logger.info(
                "Calling web_fetch_activity",
                url=url,
                objective_len=len(objective),
                download_files=tool_call.get("download_files"),
            )
            result = await execute_activity(
                web_fetch_activity,
                args=[
                    url,
                    objective,
                    tool_call.get("excerpts", True),
                    tool_call.get("full_content", False),
                    tool_call.get("download_files"),
                    user_id,
                ],
                start_to_close_timeout=timedelta(seconds=180),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=PARALLEL_AI_COST_CENTS,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=completed_title,
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [{"cost_cents": PARALLEL_AI_COST_CENTS, "provider": "Parallel AI Extract"}],
                },
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=failed_title,
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ── Singleton ──

_manager: Optional[WebFetchManager] = None


def get_manager() -> WebFetchManager:
    """Get or create web fetch manager singleton."""
    global _manager
    if _manager is None:
        _manager = WebFetchManager()
    return _manager


# ── Tool entry point ──


async def web_fetch(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute web fetch tool."""
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )


# ── Temporal activity ──


@activity.defn
@traced("web_fetch_activity")
async def web_fetch_activity(
    url: str,
    objective: str,
    excerpts: bool = True,
    full_content: bool = False,
    download_files: Optional[List[str]] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Activity: Fetch and extract content from a URL with JavaScript rendering support.

    Uses Parallel AI's extract API for content extraction from JS-rendered pages.
    """
    try:
        return await fetch_and_extract(
            url=url,
            objective=objective,
            excerpts=excerpts,
            full_content=full_content,
            download_files=download_files,
            user_id=user_id,
        )
    except Exception as e:
        logger.error("Web fetch failed", error=str(e), url=url, objective=objective)
        raise
