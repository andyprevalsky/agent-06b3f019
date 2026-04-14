"""Send email tool - re-exports from domains/send_email.

This shim preserves backward-compatible import paths.
All logic lives in domains/send_email/.
"""

from domains.send_email.handler import SendEmailManager, get_manager, send_email
from domains.send_email.repo import send_email_activity

__all__ = [
    "SendEmailManager",
    "get_manager",
    "send_email",
    "send_email_activity",
]
