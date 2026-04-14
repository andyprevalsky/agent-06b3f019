"""Backward-compatibility shim -- delegates to domains/check_monitor_events.

All business logic now lives in domains/check_monitor_events/.
This file exists solely so existing imports (tests, workflow, worker) continue to resolve.
"""

from domains.check_monitor_events.handler import check_monitor_events
from domains.check_monitor_events.repo import check_monitor_events_activity
from domains.check_monitor_events.service import CheckMonitorEventsManager, get_manager
from helpers.handle_tool_event import handle_tool_event

__all__ = [
    "CheckMonitorEventsManager",
    "check_monitor_events",
    "check_monitor_events_activity",
    "get_manager",
    "handle_tool_event",
]
