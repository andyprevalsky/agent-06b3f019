"""Shared timeout budgets for LLM-backed Temporal activities."""

STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS = 600

# Verifier calls are LLM calls over potentially large context windows. Keep
# their activity wrapper aligned with the normal LLM activity budget so the
# Rose client can enforce its own provider deadline before Temporal kills it.
VERIFIER_ACTIVITY_TIMEOUT_SECONDS = STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS

# A lifecycle event mirrors to at most two channels and shares two correction
# calls across them: two 60s model calls plus four 30s sends and 30s overhead.
# The activity envelope also owns backend/storage and HTTP transport overhead.
SMS_NOTIFICATION_MODEL_TIMEOUT_SECONDS = 60
SMS_NOTIFICATION_SEND_TIMEOUT_SECONDS = 30
SMS_NOTIFICATION_MAX_CHANNELS = 2
SMS_NOTIFICATION_MAX_CORRECTIONS = 2
SMS_NOTIFICATION_BACKEND_OVERHEAD_SECONDS = 30
SMS_NOTIFICATION_MAX_SEND_ATTEMPTS = SMS_NOTIFICATION_MAX_CHANNELS + SMS_NOTIFICATION_MAX_CORRECTIONS
SMS_NOTIFICATION_HTTP_TIMEOUT_SECONDS = (
    SMS_NOTIFICATION_MAX_CORRECTIONS * SMS_NOTIFICATION_MODEL_TIMEOUT_SECONDS
    + SMS_NOTIFICATION_MAX_SEND_ATTEMPTS * SMS_NOTIFICATION_SEND_TIMEOUT_SECONDS
    + SMS_NOTIFICATION_BACKEND_OVERHEAD_SECONDS
)
SMS_NOTIFICATION_ACTIVITY_TIMEOUT_SECONDS = SMS_NOTIFICATION_HTTP_TIMEOUT_SECONDS + 30
