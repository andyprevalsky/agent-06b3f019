"""Exa people search tool - re-export shim.

All business logic lives in domains/people_search/.
This module re-exports public symbols so existing import paths continue to work.
"""

from domains.people_search.handler import (
    ExaPeopleSearchManager,
    people_search,
    people_search_activity,
)

__all__ = [
    "ExaPeopleSearchManager",
    "people_search",
    "people_search_activity",
]
