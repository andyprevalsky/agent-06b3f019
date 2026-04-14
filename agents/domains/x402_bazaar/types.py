"""x402 Bazaar domain types.

Type aliases for the x402 Bazaar domain.
Imports: external packages only.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

# Type alias for execute_activity callable
# (either workflow.execute_activity or call_temporal_activity_from_activity)
ExecuteActivityCallable = Callable[..., Awaitable[Any]]
