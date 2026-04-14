"""Monitor domain types — type aliases and typed dictionaries."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List, TypedDict

# Type alias for the execute_activity callable passed through from workflows
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class ServiceUsageItem(TypedDict):
    """Single service usage entry for cost tracking."""

    cost_cents: int
    provider: str


class ToolUsage(TypedDict):
    """Usage breakdown returned alongside tool results."""

    llm: List[Any]
    service: List[ServiceUsageItem]


class MonitorActivityResult(TypedDict):
    """Value returned by monitor_activity."""

    monitor_id: str
    status: Dict[str, Any]


class MonitorToolResult(TypedDict):
    """Value returned by the monitor tool handler."""

    result: Dict[str, Any]
    usage: ToolUsage
