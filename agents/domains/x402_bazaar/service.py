"""x402 Bazaar domain service layer.

Business logic orchestration via ToolManager subclasses.
Imports: own repo, own types, own config, providers.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any, Dict, Optional

from temporalio.common import RetryPolicy

from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message

from .config import (
    PAY_MAX_ATTEMPTS,
    PAY_RETRY_INITIAL_INTERVAL_SECONDS,
    PAY_TIMEOUT_SECONDS,
    RETRY_BACKOFF_COEFFICIENT,
    RETRY_MAX_INTERVAL_SECONDS,
    SEARCH_MAX_ATTEMPTS,
    SEARCH_TIMEOUT_SECONDS,
    URL_DISPLAY_MAX_LENGTH,
    safe_time,
)
from .config import RETRY_INITIAL_INTERVAL_SECONDS as SEARCH_RETRY_INITIAL_SECONDS
from .repo import pay_for_x402_service_activity, search_x402_bazaar_activity

if TYPE_CHECKING:
    from .types import ExecuteActivityCallable


class SearchX402BazaarManager(ToolManager):
    """Manager for searching the x402 Bazaar for available paid API services."""

    tool_name = "search_x402_bazaar"
    read_only = True  # Research phase tool - no side effects

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute x402 Bazaar search and post events via handle_tool_event."""
        max_price_cents = tool_call.get("max_price_cents")
        keyword = tool_call.get("keyword")

        start_time = safe_time()

        # Build display message
        filters = []
        if max_price_cents:
            filters.append(f"max price: ${max_price_cents / 100:.2f}")
        if keyword:
            filters.append(f"keyword: {keyword}")
        filter_str = ", ".join(filters) if filters else "no filters"

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔍 Searching x402 Bazaar",
                message=f"Discovering paid API services ({filter_str})",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="search_x402_bazaar",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            result = await execute_activity(
                search_x402_bazaar_activity,
                args=[max_price_cents, keyword],
                start_to_close_timeout=timedelta(seconds=SEARCH_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=SEARCH_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=SEARCH_RETRY_INITIAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = safe_time() - start_time
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"✅ Found {result.get('service_count', 0)} x402 services",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="search_x402_bazaar",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {"llm": [], "service": []},
            }

        except Exception as e:
            elapsed_time = safe_time() - start_time
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ x402 Bazaar search failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="search_x402_bazaar",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": str(e), "services": [], "service_count": 0},
                "usage": {"llm": [], "service": []},
            }


class PayForX402BazaarServiceManager(ToolManager):
    """Manager for executing paid x402 service calls."""

    tool_name = "pay_for_x402_bazaar_service"
    read_only = False  # This tool makes payments - not read-only

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute a paid x402 service call and post events via handle_tool_event."""
        resource_url = tool_call.get("resource_url", "")
        method = tool_call.get("method", "GET")
        max_amount_cents = tool_call.get("max_amount_cents", 0)

        start_time = safe_time()

        # Truncate URL for display
        display_url = (
            resource_url
            if len(resource_url) <= URL_DISPLAY_MAX_LENGTH
            else resource_url[: URL_DISPLAY_MAX_LENGTH - 3] + "..."
        )

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="💳 Calling x402 Service",
                message=f"**URL:** {display_url}\n**Method:** {method}\n**Max Payment:** ${max_amount_cents / 100:.2f}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="pay_for_x402_bazaar_service",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            result = await execute_activity(
                pay_for_x402_service_activity,
                args=[resource_url, method, tool_call.get("params"), max_amount_cents],
                start_to_close_timeout=timedelta(seconds=PAY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(
                    maximum_attempts=PAY_MAX_ATTEMPTS,
                    backoff_coefficient=RETRY_BACKOFF_COEFFICIENT,
                    initial_interval=timedelta(seconds=PAY_RETRY_INITIAL_INTERVAL_SECONDS),
                    maximum_interval=timedelta(seconds=RETRY_MAX_INTERVAL_SECONDS),
                ),
            )

            elapsed_time = safe_time() - start_time
            cost_cents = result.get("amount_paid_cents", 0)
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=cost_cents,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"✅ x402 Service completed (${cost_cents / 100:.4f})",
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="pay_for_x402_bazaar_service",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": result,
                "usage": {
                    "llm": [],
                    "service": [
                        {"cost_cents": int(cost_cents), "provider": f"x402 Bazaar ({result.get('network', 'base')})"}
                    ]
                    if cost_cents > 0
                    else [],
                },
            }

        except Exception as e:
            elapsed_time = safe_time() - start_time
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ x402 Service call failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="pay_for_x402_bazaar_service",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            return {
                "result": {"error": str(e)},
                "usage": {"llm": [], "service": []},
            }


# Singletons
_search_manager: Optional[SearchX402BazaarManager] = None
_pay_manager: Optional[PayForX402BazaarServiceManager] = None


def get_search_manager() -> SearchX402BazaarManager:
    """Get or create search manager singleton."""
    global _search_manager  # noqa: PLW0603
    if _search_manager is None:
        _search_manager = SearchX402BazaarManager()
    return _search_manager


def get_pay_manager() -> PayForX402BazaarServiceManager:
    """Get or create pay manager singleton."""
    global _pay_manager  # noqa: PLW0603
    if _pay_manager is None:
        _pay_manager = PayForX402BazaarServiceManager()
    return _pay_manager
