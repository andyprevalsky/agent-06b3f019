"""Send email domain types - schemas, type aliases."""

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
# (either workflow.execute_activity or call_temporal_activity_from_activity)
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
