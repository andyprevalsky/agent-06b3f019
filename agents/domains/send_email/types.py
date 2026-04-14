"""Send email domain types - schemas, type aliases."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
# (either workflow.execute_activity or call_temporal_activity_from_activity)
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
