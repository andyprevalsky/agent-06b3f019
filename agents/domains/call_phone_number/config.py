"""Constants and defaults for the call-phone-number domain."""

# Polling configuration
INITIAL_POLL_INTERVAL_SECONDS = 3
ACTIVE_POLL_INTERVAL_SECONDS = 5
# 5s * 2600 ≈ 3.6 hours — long enough for a 3-hour hold plus the post-hold conversation.
MAX_POLL_ATTEMPTS = 2600

# Cost estimation
COST_CENTS_PER_MINUTE = 5  # ~$0.05/min estimate
MINIMUM_BILLED_MINUTES = 1

# Provider name for usage tracking
CALL_PROVIDER = "Vapi Voice Call"

# Retry policy
# The backend uses the tool_call_id-derived idempotency key to return the same
# Vapi call_id on retry instead of creating a second real phone call.
MAX_RETRY_ATTEMPTS = 2
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 5
RETRY_MAX_INTERVAL_SECONDS = 30

# Timeouts
ACTIVITY_TIMEOUT_MINUTES = 210
HEARTBEAT_TIMEOUT_SECONDS = 60
HTTP_TIMEOUT_INITIATE = 45.0
# Backend poll of a live Vapi call can exceed 15s when the provider is slow
# or the response artifact is large. Stay under HEARTBEAT_TIMEOUT_SECONDS.
HTTP_TIMEOUT_POLL = 30.0
HTTP_TIMEOUT_MESSAGE = 5.0
