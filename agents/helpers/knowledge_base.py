"""GoalBlueprints tool for learning from successful task completions."""

from typing import Dict, List, Optional
from datetime import datetime
from temporalio import activity
import structlog

from config import load_config
from helpers.llm import call_llm

logger = structlog.get_logger()

# Prompt for extracting actionable blueprints from conversation history
BLUEPRINT_EXTRACTION_PROMPT = """You are analyzing a conversation between a user and an AI agent that successfully achieved a specific goal.

Your task is to extract a concise, actionable blueprint that captures the essential steps, decisions, and learnings from this conversation.

## Input
- **Goal**: {goal_description}
- **Outcome**: Successfully completed
- **Full Conversation**: See below

## What to Extract

### 1. Core Approach (2-3 sentences)
Summarize the overall strategy that was used to achieve the goal.

### 2. Key Steps (ordered list)
Extract the specific actions taken that directly contributed to success. Include:
- What was done
- Why it was necessary
- Any important parameters or decisions

### 3. Critical Decisions
Highlight important choices made during execution, especially:
- Trade-offs considered
- Why one approach was chosen over alternatives
- Pivots or course corrections that proved valuable

### 4. Success Factors
What made this approach work? Include:
- Specific tools or techniques used
- Important insights discovered
- Context-specific considerations

### 5. Pitfalls Avoided (if any)
Briefly note any dead-ends or failed attempts that were overcome, and what was learned.

## What to Exclude
- Greeting/closing pleasantries
- Repetitive confirmations or status updates
- Failed attempts that didn't lead anywhere
- Debugging steps unless they revealed critical insights
- Tool outputs unless they contain key information

## Output Format
Provide a structured, scannable blueprint in markdown format that another agent could reference when tackling a similar goal.

Be concise but specific. Use technical terminology when appropriate. Focus on reproducibility.

Generate ONLY the blueprint content - no preamble, no "Here's the blueprint:", just the structured markdown."""


def extract_goal_from_context(context: List[Dict]) -> str:
    """
    Extract the goal from the first USER message in context.
    
    Args:
        context: Message history
        
    Returns:
        The goal text, or a default message if not found
    """
    for msg in context:
        if msg.get('role') == 'USER':
            return msg.get('text', 'No goal specified')
    
    return 'No goal specified'


class BlueprintManager:
    """Manager for GoalBlueprints via backend API."""
    
    def __init__(self):
        # All operations go through backend API
        pass
    
    async def query_by_similarity(
        self,
        goal: str,
        user_id: str,
        limit: int = 3
    ) -> List[Dict]:
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
            logger.error("Blueprint query failed", error=str(e), goal=goal)
            # Don't fail the workflow if blueprint search fails
            return []
    
    async def save(
        self,
        user_id: str,
        title: str,
        blueprint: str | List[Dict]
    ) -> Dict:
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
                
                result = response.json()
            
            logger.info(
                "Blueprint saved",
                blueprint_id=result.get("id"),
                title=title
            )
            
            return result
            
        except Exception as e:
            logger.error(
                "Blueprint save failed",
                error=str(e),
                title=title
            )
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
async def query_blueprints(
    context: List[Dict],
    user_id: str,
    limit: int = 3
) -> List[Dict]:
    """
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
async def save_blueprint(
    user_id: str,
    blueprint: List[Dict]
) -> Dict:
    """
    Activity: Save a new blueprint.
    
    Uses LLM to extract key points from the conversation history into a concise,
    actionable blueprint that can be used by future agents.
    
    Args:
        user_id: User ID
        blueprint: List of messages (execution trace, first USER message is the goal)
        
    Returns:
        Dict with 'saved_blueprint' and 'usage' (token counts)
    """
    try:
        activity.heartbeat("Extracting blueprint with LLM")
        
        # Extract goal from first USER message to use as title
        title = extract_goal_from_context(blueprint)
        
        # Format conversation history for the LLM
        conversation_text = ""
        for msg in blueprint:
            role = msg.get('role', 'ASSISTANT')
            text = msg.get('text', '')
            timestamp = msg.get('timestamp', '')
            conversation_text += f"[{role}] {text}\n\n"
        
        # Build the extraction prompt
        system_prompt = BLUEPRINT_EXTRACTION_PROMPT.format(
            goal_description=title
        )
        
        # Call LLM to extract actionable blueprint
        logger.info("Calling LLM to extract blueprint", goal=title)
        result = await call_llm(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": conversation_text}
            ],
            model="google/gemini-flash-2.5",
            temperature=0.3,  # Lower temperature for more focused extraction
            max_tokens=2000   # Allow enough tokens for detailed blueprint
        )
        
        # Extract the blueprint content from LLM response
        extracted_blueprint = result.get("content", "")
        usage = result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        
        if not extracted_blueprint:
            logger.warning("LLM returned empty blueprint, falling back to raw messages")
            extracted_blueprint = conversation_text
        
        logger.info(
            "Blueprint extracted",
            goal=title,
            original_messages=len(blueprint),
            extracted_length=len(extracted_blueprint),
            tokens_used=usage.get("total_tokens", 0)
        )
        
        # Save the extracted blueprint (as string, not list of messages)
        manager = get_blueprint_manager()
        saved_blueprint = await manager.save(user_id, title, extracted_blueprint)
        
        # Return both the saved blueprint and usage data
        return {
            "saved_blueprint": saved_blueprint,
            "usage": usage
        }
        
    except Exception as e:
        logger.error(
            "Blueprint extraction failed, saving raw messages as fallback",
            error=str(e),
            goal=title
        )
        # Fallback: save raw messages if extraction fails (no token usage)
        manager = get_blueprint_manager()
        saved_blueprint = await manager.save(user_id, title, blueprint)
        return {
            "saved_blueprint": saved_blueprint,
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }

