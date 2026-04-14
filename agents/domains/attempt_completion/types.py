"""Attempt-completion domain types — schemas, type aliases, and constants."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypedDict

# Type alias for the execute_activity callable used throughout the domain.
# Accepts variadic positional and keyword args, returns Any.
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class CompletionResult(TypedDict):
    """Return value from a successful attempt-completion invocation."""

    attempted: bool
