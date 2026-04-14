"""Backward-compatible re-exports for call-phone-number domain.

All business logic lives in domains/call_phone_number/.
This shim preserves the ``from tools.call_phone_number import ...`` contract
used by worker.py, workflows, and tests.

Note: ``asyncio`` and ``save_phone_call_message`` are re-exported here so that
blackbox tests can patch ``tools.call_phone_number.asyncio.sleep`` and
``tools.call_phone_number.save_phone_call_message`` on this module's namespace.
"""

import asyncio  # noqa: F401 — re-exported for test patching

from domains.call_phone_number.handler import (  # noqa: F401
    CallPhoneNumberManager,
    call_phone_number,
    call_phone_number_activity,
    get_manager,
    save_phone_call_message,
)

__all__ = [
    "CallPhoneNumberManager",
    "asyncio",
    "call_phone_number",
    "call_phone_number_activity",
    "get_manager",
    "save_phone_call_message",
]
