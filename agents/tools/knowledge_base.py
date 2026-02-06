"""
Knowledge base (blueprints) operations - migrated to event-driven architecture.

These are internal workflow activities, not LLM-callable tools.
They handle querying and saving successful execution patterns.
"""

from typing import Dict, List, Optional, Any, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import json
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()

# These imports are only used in activities (not workflow code), so no sandbox restrictions apply
from config import load_config
from helpers.utils import extract_goal_from_context


# ========================================
# BLUEPRINT COMPRESSION (deterministic)
# ========================================


def _build_trajectory_blueprint(context: List[Dict], title: str) -> str:
    """Build a condensed trajectory-format blueprint from conversation context.

    Deterministic extraction (no LLM needed). Produces a compact text format:
    - Header: STATUS, COST, DURATION
    - TRAJECTORY: one line per tool call with phase, tool name, key param, result
    - PLAN: full set_plan payload (if present)
    - USER MESSAGES: all user messages verbatim

    Typical output: 400-900 tokens per blueprint (vs ~12K for old JSON format).
    """
    trajectory_lines = []
    user_messages = []
    plan_json = None
    cost_dollars = None
    duration_seconds = None
    status = "SUCCESS"
    step = 0
    current_phase = "PLAN"
    seen_tool_calls = set()

    # Internal tools to skip in trajectory
    SKIP_TOOLS = {"check_progress", "completion_summary"}

    for msg in context:
        role = msg.get("role", "")
        metadata = msg.get("metadata", {}) or {}
        text = msg.get("text", "")

        # Collect user messages
        if role == "USER" and text:
            # Skip hidden/system messages
            if not metadata.get("hidden") and not metadata.get("isCustomSystemPrompt"):
                user_messages.append(text)

        # Track reasoning steps (ASSISTANT messages without tool calls)
        if role == "ASSISTANT" and text and not metadata.get("tool_calls"):
            trajectory_lines.append(f"  t:{step}  [{current_phase}]  reasoning")
            step += 1

        # Process tool messages
        if role == "TOOL":
            tool_name = metadata.get("toolName", "")
            tool_status = metadata.get("toolStatus", "")
            tool_call_id = metadata.get("toolCallId", "")

            # Skip internal tools
            if tool_name in SKIP_TOOLS:
                # But extract cost/duration from completion_summary
                if tool_name == "completion_summary" and tool_status == "FINISHED":
                    summary_data = metadata.get("completionSummary", {})
                    cost_dollars = summary_data.get("costDollars")
                    duration_seconds = summary_data.get("durationSeconds")
                elif tool_name == "completion_summary" and tool_status == "ERROR":
                    status = "FAILED"
                    summary_data = metadata.get("completionSummary", {})
                    duration_seconds = summary_data.get("durationSeconds")
                continue

            # Skip IN_PROGRESS messages (only care about FINISHED/ERROR)
            if tool_status not in ("FINISHED", "ERROR"):
                continue

            # Dedupe by tool_call_id
            if tool_call_id:
                if tool_call_id in seen_tool_calls:
                    continue
                seen_tool_calls.add(tool_call_id)

            # Extract key param from tool call
            key_param = _extract_key_param(tool_name, metadata, text)

            # Build result summary
            if tool_status == "ERROR" or metadata.get("error"):
                error_text = text[:80] if text else "error"
                result_summary = f"FAILED ({error_text})"
            else:
                result_summary = _extract_result_summary(tool_name, metadata, text)

            # Handle set_plan specially - extract full plan
            if tool_name == "set_plan" and tool_status == "FINISHED":
                plan_data = metadata.get("data", {})
                if plan_data and plan_data.get("tasks"):
                    plan_json = json.dumps(plan_data, indent=2, default=str)
                trajectory_lines.append(
                    f"  t:{step}  [{current_phase}]  set_plan → {len(plan_data.get('tasks', []))} tasks"
                )
                step += 1
                # After set_plan, we're in EXECUTE phase
                current_phase = "EXECUTE"
                continue

            # Regular tool call
            line = f"  t:{step}  [{current_phase}]  {tool_name}"
            if key_param:
                line += f"({key_param})"
            line += f" → {result_summary}"
            trajectory_lines.append(line)
            step += 1

    # Build the blueprint text
    lines = [f"STATUS: {status}"]
    if cost_dollars is not None:
        lines.append(f"COST: ${cost_dollars}")
    if duration_seconds is not None:
        minutes = duration_seconds // 60
        seconds = duration_seconds % 60
        lines.append(f"DURATION: {minutes}m {seconds}s")

    lines.append("")
    lines.append("TRAJECTORY:")
    if trajectory_lines:
        lines.extend(trajectory_lines)
    else:
        lines.append("  (no tool calls)")

    if plan_json:
        lines.append("")
        lines.append("PLAN:")
        lines.append(plan_json)

    if user_messages:
        lines.append("")
        lines.append("USER MESSAGES:")
        for um in user_messages:
            # Truncate very long user messages
            truncated = um[:500] + "..." if len(um) > 500 else um
            lines.append(f'  - "{truncated}"')

    return "\n".join(lines)


def _extract_key_param(tool_name: str, metadata: Dict, text: str) -> str:
    """Extract the most important parameter from a tool call for the trajectory line."""
    data = metadata.get("data", {}) or {}

    if tool_name == "web_search":
        return f'"{data.get("query", "")}"' if data.get("query") else ""
    if tool_name == "web_fetch":
        url = data.get("url", "")
        if url:
            # Truncate long URLs to domain
            from urllib.parse import urlparse
            try:
                parsed = urlparse(url)
                return parsed.netloc or url[:50]
            except Exception:
                return url[:50]
        return ""
    if tool_name in ("spawn_browser_agent", "spawn_sub_agent", "spawn_claude_code_agent"):
        goal = data.get("goal", "")
        return f'"{goal[:60]}"' if goal else ""
    if tool_name == "send_message_to_user":
        return ""  # Don't expose message content
    if tool_name == "find_all":
        return f'"{data.get("entity_type", "")}"' if data.get("entity_type") else ""
    if tool_name == "enrich":
        return f'"{data.get("query", "")}"' if data.get("query") else ""
    if tool_name == "monitor":
        return f'"{data.get("description", "")[:40]}"' if data.get("description") else ""
    if tool_name == "people_search":
        return f'"{data.get("query", "")}"' if data.get("query") else ""

    # Fallback: try title from metadata
    title = metadata.get("title", "")
    if title and len(title) < 60:
        return ""  # Title goes in result_summary
    return ""


def _extract_result_summary(tool_name: str, metadata: Dict, text: str) -> str:
    """Extract a concise result summary for the trajectory line."""
    title = metadata.get("title", "")
    data = metadata.get("data", {}) or {}

    if tool_name in ("spawn_browser_agent", "spawn_sub_agent", "spawn_claude_code_agent"):
        return "SUCCESS" if metadata.get("toolStatus") == "FINISHED" else "completed"
    if tool_name == "web_search":
        # Try to get result count from text
        if "results" in text.lower():
            return text[:60]
        return "results returned"
    if tool_name == "web_fetch":
        return "200" if metadata.get("toolStatus") == "FINISHED" else "fetched"
    if tool_name == "attempt_completion":
        return "SUCCESS"
    if tool_name == "send_message_to_user":
        return "sent"

    # Fallback: use title if short enough
    if title and len(title) < 50:
        return title
    return "completed"


class QueryBlueprintsManager(ToolManager):
    """Manager for querying blueprints from knowledge base."""
    
    tool_name = "query_blueprints"
    
    async def execute_tool(
        self,
        execute_activity,  # Callable to execute the activity (workflow.execute_activity or call_temporal_activity_from_activity)
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute blueprint query and yield events.
        
        Note: This is a special case - we need to return the blueprints data
        for the workflow to use, not just yield events. See workflow helper below.
        
        Yields:
            - Pre-execution status
            - Post-execution status with results
        """
        context = tool_call.get("context", [])
        user_id = tool_call.get("user_id")
        limit = tool_call.get("limit", 3)
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔍 Querying Knowledge Base",
            message="",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute query activity
        try:
            blueprints = await execute_activity(
                query_blueprints_activity,
                args=[context, user_id, limit],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Store result for workflow helper to return
            self._last_result = blueprints
            
        except Exception as e:
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Knowledge base query failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            self._last_result = []
            return
        
        # 3. Success status with results
        count = len(blueprints) if blueprints else 0
        
        if count == 0:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Searched for similar goals",
                message="",
                status=MessageStatus.FINISHED
            )
        else:
            blueprint_goals = "\n".join([f"• {bp.get('title', 'Unknown goal')}" for bp in blueprints])
            message = f"Retrieved {count} blueprint{'s' if count != 1 else ''} from knowledge base:\n\n{blueprint_goals}"
            
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Found {count} similar goal{'s' if count != 1 else ''}",
                message=message,
                status=MessageStatus.FINISHED
            )


class SaveBlueprintManager(ToolManager):
    """Manager for saving blueprints to knowledge base."""
    
    tool_name = "save_blueprint"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute blueprint save and yield events.
        
        Note: This is a special case - we need to return the result with usage data
        for the workflow to track tokens. See workflow helper below.
        
        Yields:
            - Pre-execution status
            - Post-execution status
        """
        user_id = tool_call.get("user_id")
        steps = tool_call.get("steps", [])
        
        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Saving route to goal",
            message="",
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Execute save activity (deterministic trajectory compression)
        try:
            result = await workflow.execute_activity(
                save_blueprint_activity,
                args=[user_id, steps],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Store result for workflow helper to return
            self._last_result = result
            
        except Exception as e:
            # Error status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to save route",
                message=str(e),
                status=MessageStatus.ERROR
            )
            self._last_result = None
            # Don't raise - error event already posted the formatted message
        
        # 3. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ Route to goal saved",
            message="",
            status=MessageStatus.FINISHED
        )


# ========================================
# SINGLETONS
# ========================================

_query_manager: Optional[QueryBlueprintsManager] = None
_save_manager: Optional[SaveBlueprintManager] = None


def get_query_manager() -> QueryBlueprintsManager:
    """Get or create query blueprints manager singleton."""
    global _query_manager
    if _query_manager is None:
        _query_manager = QueryBlueprintsManager()
    return _query_manager


def get_save_manager() -> SaveBlueprintManager:
    """Get or create save blueprint manager singleton."""
    global _save_manager
    if _save_manager is None:
        _save_manager = SaveBlueprintManager()
    return _save_manager


# ========================================
# WORKFLOW HELPERS
# ========================================

async def query_blueprints(
    handle_tool_event_callback,  # Callable[[ToolEvent, str, str], Awaitable[None]]
    execute_activity,  # workflow.execute_activity or call_temporal_activity_from_activity
    context: List[Dict],
    user_id: str,
    limit: int = 3
) -> List[Dict]:
    """
    Helper for querying blueprints (new event-driven system).
    
    Returns the list of blueprints (needed by workflow logic).
    
    Note: This is different from pure event-driven tools because the workflow
    needs the actual blueprints data, not just success/failure messages.
    """
    manager = get_query_manager()
    
    import uuid
    tool_call = {
        "context": context,
        "user_id": user_id,
        "limit": limit
    }
    tool_call_id = 'query_blueprints_1234567890'
    
    async for event in manager.execute_tool(execute_activity, tool_call, tool_call_id):
        await handle_tool_event_callback(event, tool_call_id, "query_blueprints")
    
    # Return the blueprints data that workflow needs
    return manager._last_result


async def save_blueprint(
    workflow_instance,
    user_id: str,
    steps: List[Dict]
) -> Dict:
    """
    Workflow helper for saving blueprints (new event-driven system).
    
    Returns the blueprint result with usage data (for token tracking).
    
    Note: This calls the existing save_blueprint activity which does LLM compression
    and returns token usage that the workflow needs to track.
    """
    manager = get_save_manager()
    
    tool_call = {
        "user_id": user_id,
        "steps": steps
    }
    tool_call_id = workflow.uuid4()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "save_blueprint")
    
    # Return the result with usage data for token tracking
    return manager._last_result


# ========================================
# TEMPORAL ACTIVITIES
# ========================================

@activity.defn
async def query_blueprints_activity(
    context: List[Dict],
    user_id: str,
    limit: int = 3
) -> List[Dict]:
    """
    Activity: Query blueprints by goal similarity via backend API.
    
    Args:
        context: Message history (first USER message is the goal)
        user_id: User ID to filter results
        limit: Maximum results
        
    Returns:
        List of similar blueprints
    """
    try:
        # Extract goal from first USER message
        goal = extract_goal_from_context(context)
        
        activity.heartbeat(f"Querying blueprints for: {goal}")
        
        config = load_config()
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/blueprints/search",
                json={
                    "goal": goal,
                    "user_id": user_id,
                    "limit": limit
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            response.raise_for_status()
            results = response.json()
        
        logger.info(
            "Blueprint query complete",
            goal=goal,
            result_count=len(results)
        )
        
        return results
        
    except Exception as e:
        logger.error("Blueprint query failed", error=str(e), goal=goal if 'goal' in locals() else 'unknown')
        # Don't fail the workflow if blueprint search fails
        return []


@activity.defn
async def save_blueprint_activity(
    user_id: str,
    blueprint: List[Dict]
) -> Dict:
    """
    Activity: Save a condensed trajectory blueprint from conversation context.

    Deterministically extracts a compact trajectory format from the conversation
    messages — no LLM call needed. Typical output is 400-900 tokens per blueprint
    (vs ~12K for the old JSON format).

    Args:
        user_id: User ID
        blueprint: List of messages (execution trace, first USER message is the goal)

    Returns:
        Dict with 'saved_blueprint'
    """
    try:
        activity.heartbeat("Building trajectory blueprint")

        # Extract goal from first USER message to use as title
        title = extract_goal_from_context(blueprint)

        # Build condensed trajectory format (deterministic, no LLM)
        compressed_text = _build_trajectory_blueprint(blueprint, title)

        # Estimate tokens (~4 chars per token)
        estimated_tokens = len(compressed_text) // 4
        logger.info(
            "Blueprint compressed (trajectory format)",
            goal=title,
            original_messages=len(blueprint),
            compressed_chars=len(compressed_text),
            estimated_tokens=estimated_tokens,
        )

        # Save the blueprint via backend API (as text string, not JSON array)
        activity.heartbeat(f"Saving blueprint: {title}")

        config = load_config()

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/blueprints",
                json={
                    "user_id": user_id,
                    "title": title,
                    "blueprint": compressed_text
                },
                headers={
                    "X-API-Key": config.backend.api_key,
                    "Content-Type": "application/json"
                },
                timeout=30.0
            )
            response.raise_for_status()
            saved_blueprint = response.json()

        logger.info(
            "Blueprint saved",
            blueprint_id=saved_blueprint.get("id"),
            title=title
        )
        
        return {"saved_blueprint": saved_blueprint}

    except Exception as e:
        logger.error("Blueprint save failed", error=str(e))
        raise

