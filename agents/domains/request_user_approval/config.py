"""Request user approval domain configuration.

Constants and defaults for the approval domain.
Imports: own types only.
"""

from utils.attention_requests import REJECTION_SENTINEL as REJECTION_SENTINEL
from utils.llm_timeouts import SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS

# Timeouts
CREATE_REQUEST_TIMEOUT_SECONDS = 30.0
SMS_NOTIFY_TIMEOUT_SECONDS = SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS

# Retry configuration
CREATE_REQUEST_MAX_ATTEMPTS = 3
SMS_NOTIFY_MAX_ATTEMPTS = 2

# Tool name constant (used in event handling)
TOOL_NAME = "request_user_approval"
