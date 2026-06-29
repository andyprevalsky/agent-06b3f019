"""People search domain -- public API.

Read-only people search for explore agents. Routes intent-based between Exa
people search (targeted lookup) and Parallel Fast Entity Search (criteria
search), normalizing both into one shape.
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
