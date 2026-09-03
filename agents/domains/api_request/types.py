"""api_request domain types."""

from typing import Any, Awaitable, Callable, Dict, Optional, TypeVar

T = TypeVar("T")
ExecuteActivityCallable = Callable[..., Awaitable[T]]

ApiRequestResult = Dict[str, Any]
