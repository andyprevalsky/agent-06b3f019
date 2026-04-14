"""Send SMS as user tool - re-export shim.

All business logic lives in domains/send_sms_as_user/.
This module re-exports public symbols so existing import paths continue to work.
"""

from domains.send_sms_as_user.handler import (
    SendSmsAsUserManager,
    queue_imessage_activity,
    send_sms_as_user,
)
from domains.send_sms_as_user.service import (
    format_phone_number,
    normalize_to_e164,
)

__all__ = [
    "SendSmsAsUserManager",
    "format_phone_number",
    "normalize_to_e164",
    "queue_imessage_activity",
    "send_sms_as_user",
]
