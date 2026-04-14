"""Deep-research domain handler — runtime entry point.

Thin orchestration layer: parses tool_call input, calls service functions,
and posts ToolEvents. Re-exports deep_research_activity from repo for
worker.py registration and test imports via the tools shim.
"""

from __future__ import annotations

from typing import Any

from domains.deep_research.config import PERPLEXITY_MODEL
from domains.deep_research.service import build_completion_message, compute_service_usage, deep_research_activity
from domains.deep_research.types import DeepResearchResult, ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

__all__ = [
    "DeepResearchManager",
    "deep_research",
    "deep_research_activity",
]


# =============================================================================
# MANAGER
# =============================================================================


class DeepResearchManager(ToolManager):
    """Manager for deep research operations using Perplexity."""

    tool_name = "deep_research"
    read_only = True  # Research phase tool

    def __init__(self) -> None:
        # Don't initialize OpenAI client here — it uses threading.local which breaks Temporal.
        # Client will be created inside the activity where it's safe.
        self.model = PERPLEXITY_MODEL

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute deep research and post events via handle_tool_event."""
        query = tool_call.get("query", "")

        # 1. Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="🔬 Conducting deep research",
                message=f"Topic: {query}\n\n*This may take several minutes as I analyze hundreds of sources...*",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="deep_research",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        # 2. Execute research activity (MOCKED — deep research disabled)
        try:
            result: DeepResearchResult = {
                "report": f"Deep research is currently disabled. Query was: {query}",
                "citations": [],
                "query": query,
                "model": PERPLEXITY_MODEL,
                "report_length": 0,
                "citation_count": 0,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "citation_tokens": 0,
                    "reasoning_tokens": 0,
                    "search_count": 0,
                },
            }
        except Exception as e:
            # Error status
            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Deep research failed",
                    message=str(e),
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="deep_research",
                execute_activity=execute_activity,
                user_id=user_id,
            )
            return {"error": str(e)}

        # 3. Compute service usage
        service_usage = compute_service_usage(result)

        # 4. Success status with report
        message = build_completion_message(result)

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Deep research completed",
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="deep_research",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {
                "llm": [],
                "service": service_usage,
            },
        }


# =============================================================================
# SINGLETON
# =============================================================================

_manager: DeepResearchManager | None = None


def get_manager() -> DeepResearchManager:
    """Get or create deep research manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = DeepResearchManager()
    return _manager


# =============================================================================
# TOOL ENTRY POINT
# =============================================================================


async def deep_research(
    execute_activity: ExecuteActivityCallable,
    tool_call: dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Execute deep_research tool.

    Args:
        execute_activity: workflow.execute_activity or call_temporal_activity_from_activity
        tool_call: Tool call dict with 'query', 'max_tokens'
        tool_call_id: Unique ID for this tool call
        agent_id: Agent ID for event routing
        user_id: User ID for usage tracking

    Returns:
        Result dict with report and citations
    """
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
    )
