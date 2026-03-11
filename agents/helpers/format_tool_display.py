"""Format tool names for display in SubAgentTree UI.

Converts raw tool names + args into human-readable display strings.
"""

from typing import Dict, Any


def format_tool_display(tool_name: str, tool_args: Dict[str, Any]) -> str:
    """
    Format a tool name and args into a human-readable display string.

    Args:
        tool_name: The raw tool name (e.g., "web_search")
        tool_args: The tool arguments dict

    Returns:
        Human-readable display string (e.g., "Searching the web for hotels")
    """
    formatters = {
        "web_search": lambda args: f"Searching the web for {_truncate(args.get('query', '...'), 50)}",
        "spawn_agent": lambda args: _format_spawn_agent(args),
        "deep_research": lambda args: f"Researching {_truncate(args.get('query', '...'), 50)}",
        "wait_seconds": lambda args: f"Waiting {args.get('seconds', '?')} seconds",
        "send_message_to_user": lambda args: "Messaging user",
        "search_user_network_for_people": lambda args: f"Searching contacts for {_truncate(args.get('name', args.get('query', '...')), 30)}",
        "find_all": lambda args: f"Finding all {_truncate(args.get('objective', '...'), 40)}",
        "enrich": lambda args: f"Enriching {_truncate(args.get('name', '...'), 30)}",
        "monitor": lambda args: f"Monitoring {_truncate(args.get('condition', '...'), 40)}",
        "check_monitor_events": lambda args: "Checking monitor",
        "message_person": lambda args: f"Messaging {_truncate(args.get('person_id', '...'), 30)}",
        "set_plan": lambda args: f"Planning {_truncate(args.get('title', '...'), 40)}",
        "attempt_completion": lambda args: "Completing task",
        "search_x402_bazaar": lambda args: f"Searching bazaar for {_truncate(args.get('query', '...'), 40)}",
        "pay_for_x402_bazaar_service": lambda args: f"Paying for {_truncate(args.get('service', '...'), 30)}",
        "request_user_signup": lambda args: "Requesting signup",
        "grep": lambda args: f"Searching messages for {_truncate(args.get('pattern', '...'), 40)}",
    }

    formatter = formatters.get(tool_name)
    if formatter:
        try:
            return formatter(tool_args)
        except Exception:
            return tool_name
    return tool_name


def _format_spawn_agent(args: Dict[str, Any]) -> str:
    """Format spawn_agent display based on type."""
    agent_type = args.get("type", "")
    goal = _truncate(args.get("goal", "..."), 50)
    type_labels = {
        "explore": f"Researching: {goal}",
        "browser": f"Browsing the web to {goal}",
        "code": f"Coding: {goal}",
        "sub_agent": f"Delegating task: {goal}",
    }
    return type_labels.get(agent_type, f"Spawning agent: {goal}")


def _truncate(text: str, max_len: int) -> str:
    """Truncate text to max_len, adding ellipsis if needed."""
    if not text:
        return "..."
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."
