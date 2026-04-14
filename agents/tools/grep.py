"""Grep tool - compatibility shim.

All implementation has moved to domains/grep/.
This file re-exports public symbols for backward compatibility.
"""

from domains.grep.handler import GrepManager, get_manager, grep
from domains.grep.repo import _data_summary_cache, fetch_local_data_summary, grep_activity

__all__ = [
    "GrepManager",
    "_data_summary_cache",
    "fetch_local_data_summary",
    "get_manager",
    "grep",
    "grep_activity",
]
