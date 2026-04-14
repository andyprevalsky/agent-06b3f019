"""Web fetch domain types — schemas, type aliases, and data structures."""

from typing import Any, Awaitable, Callable, Dict, List

# Type alias for execute_activity callable used across the domain
ExecuteActivityCallable = Callable[..., Awaitable[Any]]

# Media URLs extracted from page content
MediaUrls = Dict[str, List[str]]
"""Dict with keys 'images', 'files', 'links' — each a list of URL strings."""
