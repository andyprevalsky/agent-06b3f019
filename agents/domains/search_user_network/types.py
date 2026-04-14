"""Types for the search-user-network domain."""

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
