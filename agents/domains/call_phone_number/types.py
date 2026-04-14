"""Types for the call-phone-number domain."""

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
