"""GoalBlueprints tool for learning from successful task completions."""

from typing import Dict, List, Optional
from datetime import datetime
from temporalio import activity
import structlog

from config import load_config

logger = structlog.get_logger()


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
        blueprint: List[Dict]
    ) -> Dict:
        """
        Save a new blueprint.
        
        Args:
            user_id: User ID
            title: Goal description (used for similarity matching)
            blueprint: Complete execution trace
            
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
    
    Args:
        user_id: User ID
        blueprint: List of messages (execution trace, first USER message is the goal)
        
    Returns:
        Created blueprint
    """
    # Extract goal from first USER message to use as title
    title = extract_goal_from_context(blueprint)
    
    manager = get_blueprint_manager()
    return await manager.save(user_id, title, blueprint)

