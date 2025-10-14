"""User-configurable tools that the LLM agent can execute."""

from .web_search import web_search, format_pre_message as web_search_pre, format_post_message as web_search_post
from .deep_research import deep_research, format_pre_message as deep_research_pre, format_post_message as deep_research_post
from .wait_seconds import format_pre_message as wait_seconds_pre, format_post_message as wait_seconds_post

__all__ = [
    "web_search",
    "web_search_pre",
    "web_search_post",
    "deep_research",
    "deep_research_pre",
    "deep_research_post",
    "wait_seconds_pre",
    "wait_seconds_post",
]

