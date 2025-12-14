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
from helpers.llm import call_llm
from helpers.utils import extract_goal_from_context


# ========================================
# PROMPT FOR LLM COMPRESSION
# ========================================

BLUEPRINT_COMPRESSION_PROMPT = """You are compressing a conversation between a user and an AI agent that successfully achieved a specific goal.

Your task is to filter and compress the message history into a concise blueprint while preserving the raw data structure.

## Input
- **Goal**: {goal_description}
- **Outcome**: Successfully completed
- **Full Conversation**: Array of message objects with role/text/timestamp fields

## What to Keep

Keep messages that show:
- **User requests and goals**: All USER messages
- **Important decisions**: ASSISTANT messages explaining strategy or reasoning
- **Tool calls and results**: TOOL messages showing what actions were taken and their outcomes
- **Key insights**: ASSISTANT messages with valuable learnings or discoveries
- **Critical errors or pivots**: Messages showing important course corrections

## What to Remove

Filter out:
- Greetings, pleasantries, and closing remarks
- Repetitive confirmations ("I'll do that now", "Working on it...")
- Status updates that don't add information ("Processing...", "Please wait...")
- Verbose tool outputs - compress to key data points only
- Redundant explanations - keep the first, remove repeats

## How to Compress

For messages you keep:
- **Preserve structure**: Keep the role/text format intact
- **Compress verbose content**: Condense long tool outputs to essential data (e.g., "Found 50 results" instead of listing all 50)
- **Keep parameters**: Preserve tool call parameters and arguments
- **Maintain causality**: Keep enough context to understand why actions were taken

## Output Format

Return a valid JSON array of message objects. Each message must have:
- `role`: "USER", "ASSISTANT", "TOOL", or "SYSTEM"
- `text`: The message content (compressed if needed)
- `timestamp`: ISO 8601 timestamp string (preserve from original or generate if missing)
- `metadata` (optional): Contains tool execution data like:
  - For ASSISTANT messages: `tool_calls` array with tool names and arguments
  - For TOOL messages: `toolCallId`, `toolName`, `toolStatus`, `title`

Example output:
```json
[
  {{"role": "USER", "text": "Search for Python tutorials", "timestamp": "2025-01-15T10:00:00Z"}},
  {{"role": "ASSISTANT", "text": "I'll search for that", "timestamp": "2025-01-15T10:00:03Z", "metadata": {{"tool_calls": [{{"tool": "web_search", "query": "Python tutorials", "tool_call_id": "abc123"}}]}}}},
  {{"role": "TOOL", "text": "web_search(query='Python tutorials') → Found RealPython.com (4.8★), LearnPython.org, Official Docs", "timestamp": "2025-01-15T10:00:05Z", "metadata": {{"toolCallId": "abc123", "toolName": "web_search", "toolStatus": "FINISHED", "title": "🔍 Web Search"}}}},
  {{"role": "ASSISTANT", "text": "Found 3 high-quality resources. RealPython.com is best for beginners.", "timestamp": "2025-01-15T10:00:10Z"}}
]
```

Return ONLY the JSON array - no explanations, no markdown fences, just the raw JSON."""


class QueryBlueprintsManager(ToolManager):
    """Manager for querying blueprints from knowledge base."""
    
    tool_name = "query_blueprints"
    
    async def execute_tool(
        self,
        workflow_instance,
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
            blueprints = await workflow.execute_activity(
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
        
        # 2. Execute save activity (does LLM compression and returns usage)
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
    workflow_instance,
    context: List[Dict],
    user_id: str,
    limit: int = 3
) -> List[Dict]:
    """
    Workflow helper for querying blueprints (new event-driven system).
    
    Returns the list of blueprints (needed by workflow logic).
    
    Note: This is different from pure event-driven tools because the workflow
    needs the actual blueprints data, not just success/failure messages.
    """
    manager = get_query_manager()
    
    tool_call = {
        "context": context,
        "user_id": user_id,
        "limit": limit
    }
    tool_call_id = workflow.uuid4()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "query_blueprints")
    
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
    Activity: Save a new blueprint with LLM compression.
    
    Uses LLM to compress the conversation history by filtering noise and condensing
    verbose content while preserving the raw message structure.
    
    Args:
        user_id: User ID
        blueprint: List of messages (execution trace, first USER message is the goal)
        
    Returns:
        Dict with 'saved_blueprint' and 'usage' (token counts)
    """
    try:
        activity.heartbeat("Compressing blueprint with LLM")
        
        # Extract goal from first USER message to use as title
        title = extract_goal_from_context(blueprint)
        
        # Format conversation history as JSON for the LLM
        conversation_json = json.dumps(blueprint, indent=2)
        
        # Build the compression prompt
        system_prompt = BLUEPRINT_COMPRESSION_PROMPT.format(
            goal_description=title
        )
        
        # Call LLM to compress blueprint
        logger.info("Calling LLM to compress blueprint", goal=title, original_messages=len(blueprint))
        result = await call_llm(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": conversation_json}
            ],
            model="google/gemini-2.5-flash",
            temperature=0.3,
            max_tokens=4000,
            response_format={"type": "json_object"}
        )
        
        # Parse the compressed blueprint from LLM response
        compressed_blueprint_str = result.get("content", "")
        usage = result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        
        if not compressed_blueprint_str:
            logger.warning("LLM returned empty blueprint, falling back to raw messages")
            compressed_blueprint = blueprint
        else:
            try:
                # Parse JSON response
                compressed_blueprint = json.loads(compressed_blueprint_str)
                
                # Validate it's a list
                if not isinstance(compressed_blueprint, list):
                    logger.warning("LLM returned non-list JSON, falling back to raw messages")
                    compressed_blueprint = blueprint
                else:
                    logger.info(
                        "Blueprint compressed",
                        goal=title,
                        original_messages=len(blueprint),
                        compressed_messages=len(compressed_blueprint),
                        compression_ratio=f"{len(compressed_blueprint)/len(blueprint)*100:.1f}%",
                        tokens_used=usage.get("total_tokens", 0)
                    )
            except json.JSONDecodeError as e:
                logger.warning(
                    "Failed to parse LLM JSON response, falling back to raw messages",
                    error=str(e),
                    response_preview=compressed_blueprint_str[:200]
                )
                compressed_blueprint = blueprint
        
        # Save the compressed blueprint via backend API
        activity.heartbeat(f"Saving blueprint: {title}")
        
        config = load_config()
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/blueprints",
                json={
                    "user_id": user_id,
                    "title": title,
                    "blueprint": compressed_blueprint
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
        
        # Return both the saved blueprint and usage data
        return {
            "saved_blueprint": saved_blueprint,
            "usage": usage
        }
        
    except Exception as e:
        logger.error(
            "Blueprint save failed, attempting fallback to raw messages",
            error=str(e)
        )
        # Fallback: save raw messages if compression fails (no token usage)
        try:
            activity.heartbeat("Fallback: saving raw messages")
            title = extract_goal_from_context(blueprint)
            
            config = load_config()
            
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{config.backend.api_url}/api/blueprints",
                    json={
                        "user_id": user_id,
                        "title": title,
                        "blueprint": blueprint
                    },
                    headers={
                        "X-API-Key": config.backend.api_key,
                        "Content-Type": "application/json"
                    },
                    timeout=30.0
                )
                response.raise_for_status()
                saved_blueprint = response.json()
            
            return {
                "saved_blueprint": saved_blueprint,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            }
        except Exception as fallback_error:
            logger.error("Fallback save also failed", error=str(fallback_error))
            raise

