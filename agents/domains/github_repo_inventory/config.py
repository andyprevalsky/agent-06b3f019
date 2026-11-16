"""Constants for the project inventory domain (root agent environment block)."""

from datetime import timedelta

# Per-request HTTP timeout for GET /api/projects. Short: the project list is
# high-level context, never worth delaying a root's turn for.
PROJECT_INVENTORY_TIMEOUT_SECONDS = 5.0

# Workflow-side start_to_close timeout; one attempt (a failure keeps the last listing).
ACTIVITY_TIMEOUT = timedelta(seconds=10)

PROJECTS_PATH = "/api/projects"
