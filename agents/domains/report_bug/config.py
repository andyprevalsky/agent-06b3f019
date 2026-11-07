"""Constants for the report_bug domain."""

from datetime import timedelta

TOOL_NAME = "report_bug"

# Report Bug is admin-only. Mirrors ADMIN_USER_IDS in back-end/src/utils/adminAccess.ts
# (parity test in tests/blackbox/report_bug.blackbox.py); a code constant keeps the
# workflow's tool list deterministic. The backend stays the authority.
REPORT_BUG_USER_IDS = frozenset(
    {
        "1f85ff25-6e29-4c1b-8739-f917bd101a30",  # Andy Prevalsky
        "8283e892-b0a4-4298-9ef7-b95bcc67e46b",  # Tamara Chayo
        "43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9",  # Tamara (legacy)
    }
)

# The backend bounds its boxes.dev request at 30 s.
REPORT_BUG_HTTP_TIMEOUT_SECONDS = 45.0
ACTIVITY_TIMEOUT = timedelta(seconds=60)

# Backend error text kept in a failed tool result.
ERROR_TEXT_MAX_LEN = 300
