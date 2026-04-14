"""Check monitor events domain types.

Type aliases for the check-monitor-events domain.
Imports: external packages only.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
