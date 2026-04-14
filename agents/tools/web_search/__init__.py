"""Web search domain -- public API.

Re-exports for backward compatibility so existing imports
(e.g. ``from tools.web_search import web_search_activity``) keep working.
"""

from tools.web_search.handler import WebSearchManager, web_search, web_search_activity

__all__ = [
    "WebSearchManager",
    "web_search",
    "web_search_activity",
]
