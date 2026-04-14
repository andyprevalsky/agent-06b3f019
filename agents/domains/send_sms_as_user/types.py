"""Send SMS as user domain types - type aliases and data structures."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
