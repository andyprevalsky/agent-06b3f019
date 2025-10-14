"""Formatters for spawn_sub_agents tool messages."""

from typing import Dict, Any, List


def format_pre_message(tool_call: Dict[str, Any]) -> Dict[str, str]:
    """
    Format the pre-execution message for spawning sub-agents.
    Note: Individual sub-agent progress is tracked separately below this message.
    
    Args:
        tool_call: Dict with "tool" and "sub_agents" fields (from Pydantic model)
    """
    sub_agents = tool_call.get("sub_agents", [])
    
    if not sub_agents:
        return {
            "title": "🚀 Spawning sub-agents",
            "message": "No sub-agents specified"
        }
    
    # Build list of subtasks
    subtasks = []
    for i, agent in enumerate(sub_agents, 1):
        goal = agent.get("goal", "Unknown goal")
        # Note: Model will be inherited from parent if not specified
        model = agent.get("model", "parent model")
        subtasks.append(f"{i}. {goal}")
    
    return {
        "title": f"🚀 Spawning {len(sub_agents)} sub-agent{'s' if len(sub_agents) != 1 else ''}",
        "message": "Delegating subtasks (watch progress below):\n" + "\n".join(subtasks)
    }


def format_post_message(tool_call: Dict[str, Any], result: Any) -> Dict[str, str]:
    """
    Format the post-execution summary after ALL sub-agents complete.
    Note: Individual sub-agent completion is already shown above via separate messages.
    """
    
    # Handle error case
    if isinstance(result, str):
        return {
            "title": "❌ Sub-agents failed",
            "message": result
        }
    
    # Parse result dict
    if not isinstance(result, dict):
        return {
            "title": "✅ Sub-agents completed",
            "message": str(result)
        }
    
    spawned = result.get("spawned", 0)
    completed = result.get("completed", 0)
    failed = result.get("failed", 0)
    
    # Build summary message (detailed results already shown above)
    if failed == 0:
        title = f"⭐ All {spawned} sub-agent{'s' if spawned != 1 else ''} completed"
        message = f"All parallel subtasks finished successfully. Review individual results above."
    else:
        title = f"⚠️ Sub-agents finished: {completed} succeeded, {failed} failed"
        message = f"Completed with mixed results. Review individual outcomes above."
    
    return {
        "title": title,
        "message": message
    }

