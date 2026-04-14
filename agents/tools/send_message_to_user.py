"""Re-export shim -- domain logic lives in domains/send_message_to_user/.

This file preserves backward-compatible imports for:
  - workflows/agent_workflow.py  (imports send_message_to_user)
  - tests/blackbox/             (imports SendMessageToUserManager)
"""

from domains.send_message_to_user.handler import (  # noqa: F401
    SendMessageToUserManager,
    get_manager,
    send_message_to_user,
)
