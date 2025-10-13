"""Message formatters for workflow activities."""

from typing import Dict, List, Any


def format_query_blueprints_pre(args) -> Dict[str, str]:
    """Format pre-execution message for query_blueprints"""
    return {
        "title": "Querying Knowledge Base",
        "message": ""
    }


def format_query_blueprints_post(args, result: List[Dict]) -> Dict[str, str]:
    """Format post-execution message for query_blueprints"""
    count = len(result) if result else 0
    if count == 0:
        title = "No similar goals found"
        message = ""
    else:
        title = f"Found {count} similar goal{'s' if count != 1 else ''}"
        # List each blueprint's goal on a new line
        blueprint_goals = "\n".join([f"• {bp.get('title', 'Unknown goal')}" for bp in result])
        message = f"Retrieved {count} blueprint{'s' if count != 1 else ''} from knowledge base:\n\n{blueprint_goals}"
    
    return {
        "title": title,
        "message": message
    }


def format_save_blueprint_pre(args) -> Dict[str, str]:
    """Format pre-execution message for save_blueprint"""
    return {
        "title": "Saving route to goal",
        "message": ""
    }


def format_save_blueprint_post(args, result: Any) -> Dict[str, str]:
    """Format post-execution message for save_blueprint"""
    return {
        "title": "Route to goal saved",
        "message": ""
    }

