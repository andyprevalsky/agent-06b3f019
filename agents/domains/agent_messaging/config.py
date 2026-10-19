"""Constants for the agent-messaging domain."""

from datetime import timedelta

# Per-request HTTP timeout for the backend tree / agent-messages endpoints.
AGENT_MESSAGING_TIMEOUT_SECONDS = 15.0

# Workflow-side start_to_close timeout for both messaging activities.
ACTIVITY_TIMEOUT = timedelta(seconds=30)

# Goal text shown per list_agents row and per header breadcrumb.
RENDER_GOAL_LEN = 120
HEADER_GOAL_LEN = 40

# Backend error text kept in a failed delivery result.
ERROR_TEXT_MAX_LEN = 200
