"""Wait-for domain data access.

This domain has no direct database or file I/O of its own.
All data fetching (network metadata, local data summary) is delegated to
activities from other domains (spawn_agent, grep) at the service layer.
"""

# No repo functions needed -- wait_for is a pure orchestration domain.
