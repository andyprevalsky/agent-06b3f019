"""People search domain -- public API.

Read-only Lantern people discovery and source-profile retrieval for explore
agents, with normalized results and original source provenance.
"""

from tools.people_search.handler import (
    PeopleSearchManager,
    people_search,
    people_search_activity,
)

__all__ = [
    "PeopleSearchManager",
    "people_search",
    "people_search_activity",
]
