"""Common utility functions used across multiple helpers and tools."""

from typing import Dict, List


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
