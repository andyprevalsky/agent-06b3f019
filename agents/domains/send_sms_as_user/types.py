"""Send SMS as user domain types - type aliases and data structures."""

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
