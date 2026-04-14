"""GoalBlueprints tool for learning from successful task completions."""

from typing import Dict, List, Optional

import structlog
from temporalio import activity

from helpers.llm import call_llm

logger = structlog.get_logger()

# Prompt for compressing conversation history into a concise blueprint
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


def extract_goal_from_context(context: List[Dict]) -> str:
    """
    Extract the goal from the first USER message in context.

    Args:
        context: Message history

    Returns:
        The goal text, or a default message if not found
    """
    for msg in context:
        if msg.get("role") == "USER":
            return msg.get("text", "No goal specified")

    return "No goal specified"


class BlueprintManager:
    """Manager for GoalBlueprints via backend API."""

    def __init__(self):
        # All operations go through backend API
        pass

    async def query_by_similarity(self, goal: str, user_id: str, limit: int = 3) -> List[Dict]:
        """
        Query blueprints by goal similarity using cosine similarity.

        Args:
            goal: The goal to find similar blueprints for
            user_id: User ID to filter results
            limit: Maximum number of results

        Returns:
            List of similar blueprints ordered by similarity
        """
        try:
            activity.heartbeat(f"Querying blueprints for: {goal}")

            # Call backend API endpoint for blueprint search
            # The backend handles embedding generation and cosine similarity
            import httpx

            from config import load_config

            config = load_config()

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{config.backend.api_url}/api/blueprints/search",
                    json={"goal": goal, "user_id": user_id, "limit": limit},
                    headers={"X-API-Key": config.backend.api_key, "Content-Type": "application/json"},
                    timeout=30.0,
                )
                response.raise_for_status()

                results = response.json()

            logger.info("Blueprint query complete", goal=goal, result_count=len(results))

            return results

        except Exception as e:
            logger.error("Blueprint query failed", error=str(e), goal=goal)
            # Don't fail the workflow if blueprint search fails
            return []

    async def save(self, user_id: str, title: str, blueprint: str | List[Dict]) -> Dict:
        """
        Save a new blueprint.

        Args:
            user_id: User ID
            title: Goal description (used for similarity matching)
            blueprint: Extracted blueprint (string) or complete execution trace (list of messages)

        Returns:
            Created blueprint entry
        """
        try:
            activity.heartbeat(f"Saving blueprint: {title}")

            import httpx

            from config import load_config

            config = load_config()

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{config.backend.api_url}/api/blueprints",
                    json={"user_id": user_id, "title": title, "blueprint": blueprint},
                    headers={"X-API-Key": config.backend.api_key, "Content-Type": "application/json"},
                    timeout=30.0,
                )
                response.raise_for_status()

                result = response.json()

            logger.info("Blueprint saved", blueprint_id=result.get("id"), title=title)

            return result

        except Exception as e:
            logger.error("Blueprint save failed", error=str(e), title=title)
            raise


# Singleton instance
_blueprint_manager: Optional[BlueprintManager] = None


def get_blueprint_manager() -> BlueprintManager:
    """Get or create blueprint manager singleton."""
    global _blueprint_manager
    if _blueprint_manager is None:
        _blueprint_manager = BlueprintManager()
    return _blueprint_manager


@activity.defn
async def query_blueprints_deprecated(context: List[Dict], user_id: str, limit: int = 3) -> List[Dict]:
    """
    DEPRECATED: Use tools.knowledge_base.query_blueprints_activity instead.
    Activity: Query blueprints by goal similarity.

    Args:
        context: Message history (first USER message is the goal)
        user_id: User ID to filter results
        limit: Maximum results

    Returns:
        List of similar blueprints
    """
    # Extract goal from first USER message
    goal = extract_goal_from_context(context)

    manager = get_blueprint_manager()
    return await manager.query_by_similarity(goal, user_id, limit)


@activity.defn
async def save_blueprint_deprecated(user_id: str, blueprint: List[Dict]) -> Dict:
    """
    DEPRECATED: Use tools.knowledge_base.save_blueprint_activity instead.
    Activity: Save a new blueprint.

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
        import json

        conversation_json = json.dumps(blueprint, indent=2)

        # Build the compression prompt
        system_prompt = BLUEPRINT_COMPRESSION_PROMPT.format(goal_description=title)

        # Call LLM to compress blueprint (request JSON output)
        logger.info("Calling LLM to compress blueprint", goal=title, original_messages=len(blueprint))
        result = await call_llm(
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": conversation_json}],
            model="rose-labs/rose-1-lite",
            temperature=0.3,  # Lower temperature for more focused compression
            max_tokens=4000,  # Allow enough tokens for compressed messages
            response_format={"type": "json_object"},  # Request JSON output
            call_site="save_blueprint",
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
                        compression_ratio=f"{len(compressed_blueprint) / len(blueprint) * 100:.1f}%",
                        tokens_used=usage.get("total_tokens", 0),
                    )
            except json.JSONDecodeError as e:
                logger.warning(
                    "Failed to parse LLM JSON response, falling back to raw messages",
                    error=str(e),
                    response_preview=compressed_blueprint_str[:200],
                )
                compressed_blueprint = blueprint

        # Save the compressed blueprint (as list of message dicts)
        manager = get_blueprint_manager()
        saved_blueprint = await manager.save(user_id, title, compressed_blueprint)

        # Return both the saved blueprint and usage data
        return {"saved_blueprint": saved_blueprint, "usage": usage}

    except Exception as e:
        logger.error("Blueprint compression failed, saving raw messages as fallback", error=str(e))
        # Fallback: save raw messages if compression fails (no token usage)
        manager = get_blueprint_manager()
        saved_blueprint = await manager.save(user_id, extract_goal_from_context(blueprint), blueprint)
        return {
            "saved_blueprint": saved_blueprint,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
