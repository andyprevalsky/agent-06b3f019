"""Grep domain types - type aliases and interfaces."""

from typing import Any, Awaitable, Callable, Dict

ExecuteActivityCallable = Callable[..., Awaitable[Any]]

# Result shape returned by the backend grep endpoint
GrepResult = Dict[str, Any]
