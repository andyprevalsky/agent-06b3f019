"""Constants for the GitHub repo inventory domain (root agent environment block)."""

from datetime import timedelta

# Per-request HTTP timeout for GET /api/integrations/github/repos. Short: the
# inventory is high-level context, never worth delaying a root's turn for.
GITHUB_REPO_INVENTORY_TIMEOUT_SECONDS = 5.0

# Workflow-side start_to_close timeout; one attempt (a failure omits the section).
ACTIVITY_TIMEOUT = timedelta(seconds=10)

GITHUB_REPO_INVENTORY_PATH = "/api/integrations/github/repos"
