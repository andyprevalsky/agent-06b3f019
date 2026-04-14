"""Compatibility shim -- re-exports from domains/search_user_network.

All logic has moved to domains/search_user_network/.
This file exists only so that existing import paths continue to resolve.
"""

from domains.search_user_network.handler import (  # noqa: F401
    search_user_network_activity,
    search_user_network_for_people,
)
