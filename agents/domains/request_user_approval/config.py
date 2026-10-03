"""Request user approval domain configuration.

Constants and defaults for the approval domain.
Imports: own types only.
"""

from utils.attention_requests import REJECTION_SENTINEL as REJECTION_SENTINEL

# Timeouts
CREATE_REQUEST_TIMEOUT_SECONDS = 30.0
SMS_NOTIFY_TIMEOUT_SECONDS = 30.0

# One extra SMS after the initial write_lock notification. A later timeout
# must not send a third text for the same attention request.
APPROVAL_REMINDER_TIMEOUT_MINUTES = 15
MAX_APPROVAL_REMINDERS = 1

# Retry configuration
CREATE_REQUEST_MAX_ATTEMPTS = 3
SMS_NOTIFY_MAX_ATTEMPTS = 2

# Tool name constant (used in event handling)
TOOL_NAME = "request_user_approval"
