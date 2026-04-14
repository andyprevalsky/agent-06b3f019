"""Check monitor events domain configuration.

Constants and defaults for the check-monitor-events domain.
Imports: own types only.
"""

# API configuration
PARALLEL_API_BASE_URL = "https://api.parallel.ai"
EVENTS_PATH_TEMPLATE = "/v1alpha/monitors/{monitor_id}/events"
HTTP_TIMEOUT_SECONDS = 60.0

# Activity retry configuration
ACTIVITY_TIMEOUT_SECONDS = 60
ACTIVITY_MAX_ATTEMPTS = 3
ACTIVITY_BACKOFF_COEFFICIENT = 2.0
ACTIVITY_INITIAL_INTERVAL_SECONDS = 1
ACTIVITY_MAX_INTERVAL_SECONDS = 10

# Default event limit
DEFAULT_EVENT_LIMIT = 10

# Monitor ID prefix validation
MONITOR_ID_PREFIX = "monitor_"

# Tool name constant
TOOL_NAME = "check_monitor_events"

# Cost (checking events is free)
COST_CENTS = 0
