"""Backward-compatible re-exports for send-sms domain.

All business logic lives in domains/send_sms/.
This shim preserves the ``from tools.send_sms import ...`` contract
used by worker.py, workflows, and tests.
"""

from domains.send_sms.handler import (  # noqa: F401
    SendSmsManager,
    get_manager,
    send_sms,
    send_sms_activity,
)

__all__ = [
    "SendSmsManager",
    "get_manager",
    "send_sms",
    "send_sms_activity",
]
