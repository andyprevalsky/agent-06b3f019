"""Knowledge-base handler -- Temporal activities and workflow helpers.

These are internal workflow activities, not LLM-callable tools.
They handle querying and saving successful execution patterns.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from config import load_config
from . import repo
from .service import build_trajectory_blueprint
from helpers.utils import extract_goal_from_context
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

logger = structlog.get_logger()


# ── Tool Managers ────────────────────────────────────────────────────


class QueryBlueprintsManager(ToolManager):
    """Manager for querying blueprints from knowledge base."""

    tool_name = "query_blueprints"

    async def execute_tool(
        self,
        execute_activity: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute blueprint query and yield events."""
        context = tool_call.get("context", [])
        user_id = tool_call.get("user_id")
        limit = tool_call.get("limit", 3)

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="\U0001f50d Querying Knowledge Base",
            message="",
            status=MessageStatus.IN_PROGRESS,
        )

        try:
            blueprints = await execute_activity(
                query_blueprints_activity,
                args=[context, user_id, limit],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64),
                ),
            )
            self._last_result = blueprints
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Knowledge base query failed",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            self._last_result = []
            return

        count = len(blueprints) if blueprints else 0

        if count == 0:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Searched for similar goals",
                message="",
                status=MessageStatus.FINISHED,
            )
        else:
            blueprint_goals = "\n".join([f"\u2022 {bp.get('title', 'Unknown goal')}" for bp in blueprints])
            message = (
                f"Retrieved {count} blueprint{'s' if count != 1 else ''} from knowledge base:\n\n{blueprint_goals}"
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Found {count} similar goal{'s' if count != 1 else ''}",
                message=message,
                status=MessageStatus.FINISHED,
            )


class SaveBlueprintManager(ToolManager):
    """Manager for saving blueprints to knowledge base."""

    tool_name = "save_blueprint"

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute blueprint save and yield events."""
        user_id = tool_call.get("user_id")
        steps = tool_call.get("steps", [])

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Saving route to goal",
            message="",
            status=MessageStatus.IN_PROGRESS,
        )

        try:
            result = await workflow.execute_activity(
                save_blueprint_activity,
                args=[user_id, steps],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64),
                ),
            )
            self._last_result = result
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Failed to save route",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            self._last_result = None

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="\u2713 Route to goal saved",
            message="",
            status=MessageStatus.FINISHED,
        )


# ── Singletons ───────────────────────────────────────────────────────

_query_manager: Optional[QueryBlueprintsManager] = None
_save_manager: Optional[SaveBlueprintManager] = None


def get_query_manager() -> QueryBlueprintsManager:
    """Get or create query blueprints manager singleton."""
    global _query_manager  # noqa: PLW0603
    if _query_manager is None:
        _query_manager = QueryBlueprintsManager()
    return _query_manager


def get_save_manager() -> SaveBlueprintManager:
    """Get or create save blueprint manager singleton."""
    global _save_manager  # noqa: PLW0603
    if _save_manager is None:
        _save_manager = SaveBlueprintManager()
    return _save_manager


# ── Workflow helpers ─────────────────────────────────────────────────


async def query_blueprints(
    handle_tool_event_callback: Any,
    execute_activity: Any,
    context: List[Dict],
    user_id: str,
    limit: int = 3,
) -> List[Dict]:
    """Query blueprints via the event-driven system.

    Returns the list of blueprints (needed by workflow logic).
    """
    manager = get_query_manager()

    tool_call = {"context": context, "user_id": user_id, "limit": limit}
    tool_call_id = "query_blueprints_1234567890"

    async for event in manager.execute_tool(execute_activity, tool_call, tool_call_id):
        await handle_tool_event_callback(event, tool_call_id, "query_blueprints")

    return manager._last_result


async def save_blueprint(workflow_instance: Any, user_id: str, steps: List[Dict]) -> Dict:
    """Save a blueprint via the event-driven system.

    Returns the blueprint result with usage data (for token tracking).
    """
    manager = get_save_manager()

    tool_call = {"user_id": user_id, "steps": steps}
    tool_call_id = workflow.uuid4()

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "save_blueprint")

    return manager._last_result


# ── Temporal activities ──────────────────────────────────────────────


@activity.defn
async def query_blueprints_activity(
    context: List[Dict],
    user_id: str,
    limit: int = 3,
) -> List[Dict]:
    """Query blueprints by goal similarity via backend API."""
    goal = ""
    try:
        goal = extract_goal_from_context(context)
        activity.heartbeat(f"Querying blueprints for: {goal}")

        config = load_config()
        results = await repo.search_blueprints(
            api_url=config.backend.api_url,
            api_key=config.backend.api_key,
            goal=goal,
            user_id=user_id,
            limit=limit,
        )

        logger.info("Blueprint query complete", goal=goal, result_count=len(results))
        return results

    except Exception as e:
        logger.error("Blueprint query failed", error=str(e), goal=goal)
        return []


@activity.defn
async def save_blueprint_activity(
    user_id: str,
    blueprint: List[Dict],
) -> Dict:
    """Save a condensed trajectory blueprint from conversation context.

    Deterministically extracts a compact trajectory format from the conversation
    messages -- no LLM call needed.
    """
    try:
        activity.heartbeat("Building trajectory blueprint")

        title = extract_goal_from_context(blueprint)
        compressed_text = build_trajectory_blueprint(blueprint, title)

        estimated_tokens = len(compressed_text) // 4
        logger.info(
            "Blueprint compressed (trajectory format)",
            goal=title,
            original_messages=len(blueprint),
            compressed_chars=len(compressed_text),
            estimated_tokens=estimated_tokens,
        )

        activity.heartbeat(f"Saving blueprint: {title}")

        config = load_config()
        saved_blueprint = await repo.save_blueprint(
            api_url=config.backend.api_url,
            api_key=config.backend.api_key,
            user_id=user_id,
            title=title,
            blueprint=compressed_text,
        )

        logger.info("Blueprint saved", blueprint_id=saved_blueprint.get("id"), title=title)
        return {"saved_blueprint": saved_blueprint}

    except Exception as e:
        logger.error("Blueprint save failed", error=str(e))
        raise
