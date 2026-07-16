"""Backward-compatible re-exports for the message-person domain.

The implementation has moved to domains/message_person/.
This file re-exports public symbols so existing imports continue to work.
"""

from domains.message_person.handler import (  # noqa: F401
    MessagePersonManager,
    get_manager,
    message_person,
)
from domains.message_person.repo import (  # noqa: F401
    fetch_recent_messages_activity,
    generate_message_activity,
    queue_imessage_activity,
    send_agent_sms_activity,
)
