"""Check monitor events domain types.

Type aliases for the check-monitor-events domain.
Imports: external packages only.
"""

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
