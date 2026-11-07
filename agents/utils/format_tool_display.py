"""Format tool names for display in SubAgentTree UI.

Converts raw tool names + args into human-readable display strings.
"""

from typing import Any, Dict


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
        "wait_for": lambda args: (
            f"Waiting until {args.get('until_timestamp', '?')}"
            if args.get("until_timestamp")
            else f"Waiting for {_truncate(args.get('condition', '...'), 50)}"
        ),
        "send_message_to_user": lambda args: "Messaging user",
        "message_person": lambda args: f"Messaging {_truncate(args.get('person_id', '...'), 30)}",
        "set_plan": lambda args: f"Planning {_truncate(args.get('title', '...'), 40)}",
        "attempt_completion": lambda args: "Completing task",
        "request_user_signup": lambda args: "Requesting signup",
        "report_bug": lambda args: f"Reporting bug: {_truncate(args.get('description', '...'), 40)}",
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
        "general_purpose": f"Delegating task: {goal}",
        "for_each": f"For each: {goal}",
    }
    return type_labels.get(agent_type, f"Spawning agent: {goal}")


def _truncate(text: str, max_len: int) -> str:
    """Truncate text to max_len, adding ellipsis if needed."""
    if not text:
        return "..."
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."
