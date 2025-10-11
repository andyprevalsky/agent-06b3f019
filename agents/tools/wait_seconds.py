"""Wait/sleep tool - built-in system tool."""

from typing import Dict


def format_duration(seconds: int) -> str:
    """
    Format seconds into human-readable duration.
    Examples: "5 seconds", "2 minutes", "3 hours", "1 day"
    """
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    elif seconds < 3600:
        minutes = seconds / 60
        if minutes == int(minutes):
            minutes = int(minutes)
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        else:
            return f"{minutes:.1f} minutes"
    elif seconds < 86400:
        hours = seconds / 3600
        if hours == int(hours):
            hours = int(hours)
            return f"{hours} hour{'s' if hours != 1 else ''}"
        else:
            return f"{hours:.1f} hours"
    else:
        days = seconds / 86400
        if days == int(days):
            days = int(days)
            return f"{days} day{'s' if days != 1 else ''}"
        else:
            return f"{days:.1f} days"


def format_pre_message(args) -> Dict[str, str]:
    """Format pre-execution message for wait_seconds"""
    seconds = int(args[0]) if args else 1
    duration = format_duration(seconds)
    return {
        "title": f"Waiting {duration}",
        "message": ""
    }


def format_post_message(args, result) -> Dict[str, str]:
    """Format post-execution message for wait_seconds"""
    seconds = int(args[0]) if args else 1
    duration = format_duration(seconds)
    return {
        "title": f"Waited {duration}",
        "message": ""
    }

