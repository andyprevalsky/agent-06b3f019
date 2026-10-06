"""Constants and defaults for the call-phone-number domain."""

# Polling configuration
INITIAL_POLL_INTERVAL_SECONDS = 3
ACTIVE_POLL_INTERVAL_SECONDS = 5
# After ~10 minutes of 5s polls, back off. A 3-hour hold otherwise
# fetches the growing Vapi artifact ~2k times and can stall the
# worker event loop long enough to miss a short heartbeat.
LONG_HOLD_POLL_AFTER_POLLS = 120
LONG_HOLD_POLL_INTERVAL_SECONDS = 15
# Adaptive schedule still covers 3.5h+ of hold plus the post-hold conversation.
MAX_POLL_ATTEMPTS = 2600

# Cost estimation
COST_CENTS_PER_MINUTE = 5  # ~$0.05/min estimate
# Parked on hold (wait_for_human): Twilio line + realtime STT, no Vapi minutes.
HOLD_COST_CENTS_PER_MINUTE = 2
MINIMUM_BILLED_MINUTES = 1

# Provider name for usage tracking
CALL_PROVIDER = "Vapi Voice Call"
CALL_HOLD_PROVIDER = "Phone Hold Line"

# Retry policy
# The backend uses the tool_call_id-derived idempotency key to return the same
# Vapi call_id on retry instead of creating a second real phone call.
# A 3-hour hold can see more than one Temporal heartbeat/network cancel;
# two attempts is one stall from abandoning the live call.
MAX_RETRY_ATTEMPTS = 5
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 5
RETRY_MAX_INTERVAL_SECONDS = 30

# Timeouts
ACTIVITY_TIMEOUT_MINUTES = 210
# Observed live hold: a 5.5-minute event-loop/Temporal stall cancelled
# the activity at heartbeat_timeout=60s. Phone calls run up to 210
# minutes; detecting a dead worker in 10 minutes is the right trade.
HEARTBEAT_TIMEOUT_SECONDS = 600
HTTP_TIMEOUT_INITIATE = 45.0
# Backend poll of a live Vapi call can exceed 15s when the provider is slow
# or the response artifact is large. Stay under HEARTBEAT_TIMEOUT_SECONDS.
HTTP_TIMEOUT_POLL = 30.0
HTTP_TIMEOUT_MESSAGE = 5.0
